"""Background Q&A indexing: with inline indexing, two analyses in the same minute left the second
filing with zero chunks (one batch spent ~27k of the 30k/minute budget); a shared pacer + lock fix that. Runs on a fake clock — no sleeping, no live Gemini."""

import asyncio

import pytest

from app.services import database, embeddings, indexing
from app.services.llm import LLMQuotaError
from tests.test_embeddings import FakeResponse, install_clock


@pytest.fixture
def paced(monkeypatch):
    """Fake clock + fake genai client; returns the (time, tokens) request log."""
    clock = install_clock(monkeypatch)
    sent: list[tuple[float, int]] = []

    def on_call(contents):
        sent.append((clock.t, sum(embeddings.estimate_tokens(t) for t in contents)))
        return FakeResponse(len(contents))

    class FakeModels:
        async def embed_content(self, model, contents, config):
            return on_call(contents)

    class FakeAio:
        models = FakeModels()

    class FakeClient:
        aio = FakeAio()

    monkeypatch.setattr(embeddings, "_get_client", lambda: FakeClient())

    # Chunks land in a dict instead of Supabase; chunk_count reads back from it
    # so resume-by-count and the status endpoint see real numbers.
    stored: dict[str, set[int]] = {}

    async def insert_chunks(accession_number, chunks):
        stored.setdefault(accession_number, set()).update(i for i, _, _ in chunks)

    async def chunk_count(accession_number):
        return len(stored.get(accession_number, ()))

    monkeypatch.setattr(database, "insert_chunks", insert_chunks)
    monkeypatch.setattr(database, "chunk_count", chunk_count)

    return clock, sent, stored


def filing_of(chunk_count: int) -> str:
    return "x" * (embeddings.CHUNK_SIZE * chunk_count)


# --- the collision regression ---

async def test_two_analyses_in_one_minute_both_reach_full_coverage(paced):
    """The whole point of moving indexing off the request path.
    Both filings are scheduled in the same simulated minute — the case that used to leave the second one empty — and both must reach full coverage without exceeding the token cap."""
    _, sent, stored = paced
    first, second = filing_of(40), filing_of(40)
    expected = len(embeddings.chunk_text(first))

    await asyncio.gather(
        indexing.run_index("A" * 18, first),
        indexing.run_index("B" * 18, second),
    )

    assert len(stored["A" * 18]) == expected
    assert len(stored["B" * 18]) == expected

    # Neither job knows about the other, so only the shared pacer can hold this
    for at, _ in sent:
        window = sum(tok for t, tok in sent if at - embeddings.RATE_WINDOW < t <= at)
        assert window <= embeddings.TOKENS_PER_MINUTE, (
            f"{window} tokens in the minute ending at {at}"
        )


async def test_concurrent_indexes_serialize_instead_of_interleaving(paced, monkeypatch):
    """The lock keeps one filing's batches contiguous.
    Without it both jobs would fight for the same minute's budget, each stalling the other in acquire()."""
    _, _, _ = paced
    order: list[str] = []
    fake_insert = database.insert_chunks  # already the fixture's stand-in

    async def track(accession_number, chunks):
        order.append(accession_number)
        await fake_insert(accession_number, chunks)

    monkeypatch.setattr(database, "insert_chunks", track)

    await asyncio.gather(
        indexing.run_index("A" * 18, filing_of(40)),
        indexing.run_index("B" * 18, filing_of(40)),
    )

    # Each filing needs more than one batch, so interleaving was possible...
    assert order.count("A" * 18) > 1 and order.count("B" * 18) > 1
    # ...and each still ran as one unbroken block: a single accession change.
    transitions = sum(1 for a, b in zip(order, order[1:]) if a != b)
    assert transitions == 1, f"batches interleaved: {order}"


# --- status transitions ---

async def test_status_goes_from_indexing_to_complete(paced):
    _, _, _ = paced
    accession = "C" * 18
    text = filing_of(10)
    total = len(embeddings.chunk_text(text))

    indexing.mark_scheduled(accession, total)
    pending = await indexing.status_for(accession)
    assert pending.state == indexing.INDEXING
    assert pending.chunks_indexed == 0
    assert pending.chunks_total == total

    await indexing.run_index(accession, text)

    done = await indexing.status_for(accession)
    assert done.state == indexing.COMPLETE
    assert done.chunks_indexed == total
    assert done.chunks_total == total


async def test_status_reports_live_progress_while_indexing(paced):
    """chunks_indexed comes from the database, so a poll mid-run sees the ramp."""
    _, _, stored = paced
    accession = "D" * 18
    indexing.mark_scheduled(accession, 40)
    stored[accession] = set(range(12))

    mid = await indexing.status_for(accession)
    assert mid.state == indexing.INDEXING
    assert (mid.chunks_indexed, mid.chunks_total) == (12, 40)


async def test_a_filing_that_indexes_nothing_is_unavailable(paced, monkeypatch):
    """Quota exhaustion with no chunks stored still surfaces "not available"."""
    _, _, _ = paced

    async def boom(*args, **kwargs):
        raise LLMQuotaError("quota")

    monkeypatch.setattr(embeddings, "index_filing", boom)

    accession = "E" * 18
    indexing.mark_scheduled(accession, 40)
    await indexing.run_index(accession, filing_of(40))

    status = await indexing.status_for(accession)
    assert status.state == indexing.UNAVAILABLE
    assert status.chunks_indexed == 0


async def test_run_index_never_raises(paced, monkeypatch):
    """It runs as a BackgroundTask — an exception has no caller to reach."""
    _, _, _ = paced

    async def boom(*args, **kwargs):
        raise RuntimeError("supabase is down")

    monkeypatch.setattr(embeddings, "index_filing", boom)
    await indexing.run_index("F" * 18, filing_of(4))  # must not raise


async def test_a_filing_nobody_scheduled_falls_back_to_what_is_stored(paced):
    """Analyses from before this feature, and filings a restart forgot."""
    _, _, stored = paced

    absent = await indexing.status_for("G" * 18)
    assert absent.state == indexing.UNAVAILABLE

    stored["H" * 18] = set(range(102))
    present = await indexing.status_for("H" * 18)
    assert present.state == indexing.COMPLETE
    assert present.chunks_indexed == 102


async def test_indexing_resumes_a_partially_indexed_filing(paced):
    """A dyno restart mid-index is repaired by the next run, not restarted."""
    _, sent, stored = paced
    accession = "I" * 18
    text = filing_of(30)
    total = len(embeddings.chunk_text(text))

    stored[accession] = set(range(20))  # what an interrupted run left behind
    await indexing.run_index(accession, text)

    assert len(stored[accession]) == total

    # Only the missing tail was embedded — resuming costs a third of the quota
    # a fresh index would, which is what makes restarts cheap to repair.
    per_chunk = embeddings.estimate_tokens("x" * embeddings.CHUNK_SIZE)
    assert sum(tokens for _, tokens in sent) <= (total - 20) * per_chunk
