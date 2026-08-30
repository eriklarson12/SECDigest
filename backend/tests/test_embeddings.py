import pytest

from app.config import settings
from app.services import database, embeddings
from app.services.embeddings import chunk_text, embed_texts, index_filing
from app.services.llm import LLMError, LLMQuotaError


# --- chunk_text (pure) ---

def test_short_text_passes_through_as_one_chunk():
    assert chunk_text("Total revenue was $1,000 million.") == [
        "Total revenue was $1,000 million."
    ]


def test_empty_text_yields_no_chunks():
    assert chunk_text("   \n  ") == []


def test_chunks_overlap_so_boundary_sentences_stay_findable():
    text = "".join(str(i % 10) for i in range(5000))
    chunks = chunk_text(text, size=2000, overlap=200)

    assert len(chunks) == 3
    assert chunks[0] == text[:2000]
    # Each chunk restarts 200 chars before the previous one ended
    assert chunks[1] == text[1800:3800]
    assert chunks[0][-200:] == chunks[1][:200]


def test_chunk_count_is_capped():
    text = "x" * (embeddings.CHUNK_SIZE * (embeddings.MAX_CHUNKS + 50))
    assert len(chunk_text(text)) == embeddings.MAX_CHUNKS


def test_chunking_covers_everything_fetch_filing_text_keeps():
    """MAX_CHUNKS must never be the cap that truncates.
    fetch_filing_text already trims to MAX_FILING_CHARS; a lower chunk cap would re-truncate its section selection (a flat 150 stopped at 270K chars against a 600K limit)."""
    text = "x" * settings.max_filing_chars
    assert len(chunk_text(text)) < embeddings.MAX_CHUNKS + 1
    assert len(chunk_text(text)) * embeddings.CHUNK_STRIDE >= settings.max_filing_chars


# --- embed_texts ---

class FakeEmbedding:
    def __init__(self, values):
        self.values = values


class FakeResponse:
    def __init__(self, count):
        self.embeddings = [FakeEmbedding([0.1] * embeddings.EMBED_DIM) for _ in range(count)]


def fake_client(monkeypatch, on_call):
    """Install a stand-in genai client; on_call(model, contents, config) -> response."""
    calls = []

    class FakeModels:
        async def embed_content(self, model, contents, config):
            calls.append({"model": model, "contents": contents, "config": config})
            return on_call(contents)

    class FakeAio:
        models = FakeModels()

    class FakeClient:
        aio = FakeAio()

    monkeypatch.setattr(embeddings, "_get_client", lambda: FakeClient())
    return calls


async def test_embed_texts_packs_batches_up_to_the_token_budget(monkeypatch):
    """Round trips are free, tokens aren't — so batches are filled, not split small."""
    calls = fake_client(monkeypatch, lambda contents: FakeResponse(len(contents)))
    chunk = "x" * embeddings.CHUNK_SIZE
    per_batch = embeddings.TOKEN_BUDGET // embeddings.estimate_tokens(chunk)
    texts = [chunk] * (per_batch + 3)

    vectors = await embed_texts(texts, embeddings.DOCUMENT_TASK)

    assert len(vectors) == len(texts)
    assert len(vectors[0]) == embeddings.EMBED_DIM
    assert [len(c["contents"]) for c in calls] == [per_batch, 3]
    # No request may exceed one minute's budget on its own
    for call in calls:
        tokens = sum(embeddings.estimate_tokens(t) for t in call["contents"])
        assert tokens <= embeddings.TOKEN_BUDGET
    assert calls[0]["config"].task_type == "RETRIEVAL_DOCUMENT"
    assert calls[0]["config"].output_dimensionality == embeddings.EMBED_DIM


def test_batch_size_lands_near_the_observed_token_density():
    """~1.1k tokens per 2000-char chunk → mid-20s chunks per request."""
    batches = embeddings.plan_batches(["x" * embeddings.CHUNK_SIZE] * 102)
    assert 20 <= len(batches[0]) <= 30


async def test_embed_texts_short_circuits_on_empty_input(monkeypatch):
    calls = fake_client(monkeypatch, lambda contents: FakeResponse(len(contents)))
    assert await embed_texts([], embeddings.QUERY_TASK) == []
    assert calls == []


async def test_embed_quota_error_maps_to_llm_quota_error(monkeypatch):
    class Boom(Exception):
        code = 429

    def raise_quota(contents):
        raise Boom("rate limited")

    fake_client(monkeypatch, raise_quota)

    with pytest.raises(LLMQuotaError):
        await embed_texts(["a question"], embeddings.QUERY_TASK)


# --- requests-per-day vs tokens-per-minute: 1,000 requests/day counted per *text*, not per HTTP call
# (a run of ~27 calls covering 908 chunks read RPD 995/1K); TokenPacer models tokens only, so a request 429 has no window to wait for.

_DAILY_429 = (
    "429 RESOURCE_EXHAUSTED. Quota exceeded for metric: "
    "generativelanguage.googleapis.com/embed_content_free_tier_requests, "
    "limit: 1000, model: gemini-embedding-1.0. Please retry in 34.9s"
)
_TPM_429 = (
    "429 RESOURCE_EXHAUSTED. Quota exceeded for metric: "
    "generativelanguage.googleapis.com/embed_content_free_tier_input_token_count, "
    "limit: 30000. Please retry in 12.3s"
)


def _raising_client(monkeypatch, message):
    class Boom(Exception):
        code = 429

        def __init__(self):
            super().__init__(message)
            self.message = message

    def raise_quota(contents):
        raise Boom()

    return fake_client(monkeypatch, raise_quota)


async def test_daily_request_quota_gets_its_own_error(monkeypatch):
    _raising_client(monkeypatch, _DAILY_429)

    with pytest.raises(embeddings.EmbeddingRequestQuotaError):
        await embed_texts(["a question"], embeddings.QUERY_TASK)


async def test_daily_request_quota_is_not_retried(monkeypatch):
    """Retrying spends wall clock against a counter that resets on Google's clock.
    The run this came from made 30 retries across 15 filings, every one doomed."""
    calls = _raising_client(monkeypatch, _DAILY_429)
    slept = []
    monkeypatch.setattr(embeddings, "_sleep", lambda s: slept.append(s))

    with pytest.raises(embeddings.EmbeddingRequestQuotaError):
        await embeddings._embed_batch(["chunk"], embeddings.DOCUMENT_TASK, embeddings.TokenPacer())

    assert len(calls) == 1, "a daily-quota 429 must not be retried"
    assert slept == []


async def test_token_quota_is_still_retried(monkeypatch):
    """The per-minute ceiling is the one a pause genuinely fixes — keep retrying it."""
    calls = _raising_client(monkeypatch, _TPM_429)
    monkeypatch.setattr(embeddings, "_sleep", _noop_sleep)

    with pytest.raises(LLMQuotaError) as excinfo:
        await embeddings._embed_batch(["chunk"], embeddings.DOCUMENT_TASK, embeddings.TokenPacer())

    assert not isinstance(excinfo.value, embeddings.EmbeddingRequestQuotaError)
    assert len(calls) == embeddings.MAX_QUOTA_RETRIES + 1


async def test_index_filing_propagates_the_daily_quota_error(monkeypatch):
    """Unlike a token 429, this must not be swallowed into a partial index.
    Every remaining filing would fail identically, so the caller has to be able to stop the whole run."""
    _raising_client(monkeypatch, _DAILY_429)
    monkeypatch.setattr(embeddings, "_sleep", _noop_sleep)
    monkeypatch.setattr(database, "chunk_count", lambda accession: _zero())
    monkeypatch.setattr(database, "insert_chunks", lambda accession, chunks: _none())

    with pytest.raises(embeddings.EmbeddingRequestQuotaError):
        await embeddings.index_filing(
            "000032019326000020", "x" * 5000, pacer=embeddings.TokenPacer()
        )


async def _noop_sleep(seconds):
    return None


async def _zero():
    return 0


async def _none():
    return None


async def test_embed_other_error_maps_to_llm_error(monkeypatch):
    def raise_other(contents):
        raise ValueError("bad request")

    fake_client(monkeypatch, raise_other)

    with pytest.raises(LLMError):
        await embed_texts(["a question"], embeddings.QUERY_TASK)


async def test_mismatched_embedding_count_is_an_error(monkeypatch):
    fake_client(monkeypatch, lambda contents: FakeResponse(len(contents) - 1))

    with pytest.raises(LLMError):
        await embed_texts(["a", "b"], embeddings.DOCUMENT_TASK)


# --- index_filing ---

async def test_index_filing_stores_chunks_in_document_order(monkeypatch):
    stored = []
    # Stubbed at the client, not at embed_texts: index_filing calls _embed_batch
    # directly, so patching embed_texts silently leaves the real one in the path.
    calls = fake_client(monkeypatch, lambda contents: FakeResponse(len(contents)))

    async def capture(accession_number, chunks):
        stored.extend(chunks)

    monkeypatch.setattr(database, "insert_chunks", capture)

    count = await index_filing("000032019325000057", "x" * 5000)

    assert count == 3
    assert [index for index, _, _ in stored] == [0, 1, 2]
    assert calls[0]["config"].task_type == embeddings.DOCUMENT_TASK


async def test_unpaced_index_sends_one_batch_and_stops(monkeypatch):
    """Inline analyze must not stall: a second request would 429 anyway."""
    stored = []
    calls = fake_client(monkeypatch, lambda contents: FakeResponse(len(contents)))

    async def capture(accession_number, chunks):
        stored.extend(chunks)

    monkeypatch.setattr(database, "insert_chunks", capture)
    monkeypatch.setattr(embeddings, "_sleep", _unexpected_sleep)

    # Three batches' worth of text, but only the first should be sent
    chunks_per_batch = len(embeddings.plan_batches(["x" * embeddings.CHUNK_SIZE] * 200)[0])
    text = "x" * (embeddings.CHUNK_SIZE * chunks_per_batch * 3)

    count = await index_filing("000032019325000057", text)

    assert len(calls) == 1
    assert count == chunks_per_batch
    assert [index for index, _, _ in stored] == list(range(chunks_per_batch))


async def test_index_filing_with_empty_text_does_nothing(monkeypatch):
    async def fail(*args, **kwargs):
        raise AssertionError("should not embed empty text")

    monkeypatch.setattr(embeddings, "embed_texts", fail)
    assert await index_filing("000032019325000057", "  ") == 0


# --- token pacing (the backfill path) ---

class FakeClock:
    """Monotonic clock that only advances when the code under test sleeps."""

    def __init__(self):
        self.t = 1000.0
        self.slept = []

    def now(self):
        return self.t

    async def sleep(self, seconds):
        self.slept.append(seconds)
        self.t += seconds


def install_clock(monkeypatch) -> FakeClock:
    clock = FakeClock()
    monkeypatch.setattr(embeddings, "_now", clock.now)
    monkeypatch.setattr(embeddings, "_sleep", clock.sleep)
    return clock


async def _unexpected_sleep(seconds):
    raise AssertionError(f"unpaced path must not sleep (asked for {seconds}s)")


async def test_a_request_larger_than_the_budget_admits_once_the_window_drains(
    monkeypatch,
):
    """Oversized requests must drain-and-go, not deadlock — and not crash.
    Regression: the empty-window escape was evaluated *before* `_used` purged, causing an IndexError on `self._spent[0]` when a window emptied mid-call."""
    clock = install_clock(monkeypatch)
    pacer = embeddings.TokenPacer(budget=200_000)
    pacer.record(198_730)  # a large filing already occupying the window

    await pacer.acquire(333_334)  # larger than the budget itself: can never "fit"

    assert clock.slept, "it must still wait out the occupied window"
    assert clock.t - 1000.0 >= embeddings.RATE_WINDOW


async def test_an_oversized_request_on_an_empty_window_does_not_wait(monkeypatch):
    """Nothing is metered yet, so there is nothing to wait for."""
    clock = install_clock(monkeypatch)

    await embeddings.TokenPacer(budget=200_000).acquire(333_334)

    assert clock.slept == []


async def test_paced_index_never_exceeds_the_rolling_minute_budget(monkeypatch):
    """The whole point: stay under 30k tokens in any 60s window, without 429s."""
    clock = install_clock(monkeypatch)
    sent: list[tuple[float, int]] = []  # (clock time, tokens) per request

    def on_call(contents):
        sent.append((clock.t, sum(embeddings.estimate_tokens(t) for t in contents)))
        return FakeResponse(len(contents))

    fake_client(monkeypatch, on_call)

    async def noop_insert(accession_number, chunks):
        pass

    monkeypatch.setattr(database, "insert_chunks", noop_insert)

    # A WM-sized filing: 102 chunks, ~115k tokens, ~5 minutes of budget
    text = "x" * (embeddings.CHUNK_SIZE * 102)
    stored = await index_filing(
        "000110465926088016", text, pacer=embeddings.TokenPacer()
    )

    assert stored == len(chunk_text(text))
    assert len(sent) >= 4  # multiple requests, and it had to wait between them

    # For every request, the tokens sent in the preceding 60s must fit the cap
    for at, _ in sent:
        window = sum(tok for t, tok in sent if at - embeddings.RATE_WINDOW < t <= at)
        assert window <= embeddings.TOKENS_PER_MINUTE, (
            f"{window} tokens in the minute ending at {at}"
        )


async def test_paced_index_honours_retry_after_instead_of_aborting(monkeypatch):
    """Safety net for an over-count: back off by the server's own retryDelay."""
    clock = install_clock(monkeypatch)
    attempts = []

    class Boom(Exception):
        code = 429

        def __str__(self):
            return '{"error": {"details": [{"retryDelay": "38s"}]}}'

    def on_call(contents):
        attempts.append(clock.t)
        if len(attempts) == 1:
            raise Boom()
        return FakeResponse(len(contents))

    fake_client(monkeypatch, on_call)

    async def noop_insert(accession_number, chunks):
        pass

    monkeypatch.setattr(database, "insert_chunks", noop_insert)

    stored = await index_filing(
        "000032019325000057", "x" * 5000, pacer=embeddings.TokenPacer()
    )

    assert stored == 3  # retried and finished rather than storing a partial index
    assert len(attempts) == 2
    assert 38.0 in clock.slept  # the server's delay, not a blind 60s


async def test_paced_index_gives_up_after_bounded_retries(monkeypatch):
    """Retries are a safety net, not an infinite loop."""
    install_clock(monkeypatch)

    class Boom(Exception):
        code = 429

    def always_429(contents):
        raise Boom("rate limited")

    calls = fake_client(monkeypatch, always_429)

    async def noop_insert(accession_number, chunks):
        pass

    monkeypatch.setattr(database, "insert_chunks", noop_insert)

    stored = await index_filing(
        "000032019325000057", "x" * 5000, pacer=embeddings.TokenPacer()
    )

    assert stored == 0
    assert len(calls) == embeddings.MAX_QUOTA_RETRIES + 1


async def test_resume_skips_chunks_already_stored(monkeypatch):
    """A filing left partial by the inline pass gets topped up, not re-embedded."""
    install_clock(monkeypatch)
    stored = []
    calls = fake_client(monkeypatch, lambda contents: FakeResponse(len(contents)))

    async def capture(accession_number, chunks):
        stored.extend(chunks)

    monkeypatch.setattr(database, "insert_chunks", capture)
    monkeypatch.setattr(database, "chunk_count", lambda accession: _async(2))

    count = await index_filing(
        "000032019325000057", "x" * 5000, pacer=embeddings.TokenPacer(), resume=True
    )

    assert count == 1  # 3 chunks total, 2 already stored
    assert [index for index, _, _ in stored] == [2]  # numbering continues
    assert len(calls[0]["contents"]) == 1  # only the missing chunk was embedded


async def test_resume_on_a_complete_filing_embeds_nothing(monkeypatch):
    def fail(contents):
        raise AssertionError("nothing left to embed")

    fake_client(monkeypatch, fail)
    monkeypatch.setattr(database, "chunk_count", lambda accession: _async(99))

    assert await index_filing("000032019325000057", "x" * 5000, resume=True) == 0


async def _async(value):
    return value


# --- Daily embedding budget (app/quota.py). The ceiling that actually binds: one request
# per text, so an evening of nine analyses spent it and left the last filing with zero chunks.

@pytest.mark.asyncio
async def test_budget_refusal_stops_the_call_before_gemini(monkeypatch):
    """Reserving is the point: the refusal must land before the request, not after
    Google returns a 429 that has already stranded the filing."""
    called = False

    class FakeModels:
        async def embed_content(self, model, contents, config):
            nonlocal called
            called = True
            return FakeResponse(len(contents))

    class FakeAio:
        models = FakeModels()

    class FakeClient:
        aio = FakeAio()

    async def refused(day, cap, amount):
        return False

    monkeypatch.setattr(embeddings, "_get_client", lambda: FakeClient())
    monkeypatch.setattr(database, "increment_embedding_usage", refused)

    with pytest.raises(embeddings.EmbeddingRequestQuotaError):
        await embeddings.embed_texts(["a question"], embeddings.QUERY_TASK)
    assert called is False


@pytest.mark.asyncio
async def test_budget_is_reserved_per_text_not_per_batch(monkeypatch):
    """Batching saves round trips and TPM headroom, never daily quota — the reservation
    has to count texts or a packed batch would spend one unit for fifty chunks."""
    reserved: list[int] = []

    class FakeModels:
        async def embed_content(self, model, contents, config):
            return FakeResponse(len(contents))

    class FakeAio:
        models = FakeModels()

    class FakeClient:
        aio = FakeAio()

    async def record(day, cap, amount):
        reserved.append(amount)
        return True

    monkeypatch.setattr(embeddings, "_get_client", lambda: FakeClient())
    monkeypatch.setattr(database, "increment_embedding_usage", record)

    await embeddings.embed_texts(["a", "b", "c"], embeddings.DOCUMENT_TASK)
    assert sum(reserved) == 3


@pytest.mark.asyncio
async def test_a_refused_reservation_keeps_chunks_already_stored(monkeypatch):
    """Same contract as a real daily-quota 429: stop the run, keep the partial index
    so the next attempt resumes instead of starting over."""
    stored: dict[str, set[int]] = {}
    budget = {"left": 1}

    class FakeModels:
        async def embed_content(self, model, contents, config):
            return FakeResponse(len(contents))

    class FakeAio:
        models = FakeModels()

    class FakeClient:
        aio = FakeAio()

    async def insert_chunks(accession_number, chunks):
        stored.setdefault(accession_number, set()).update(i for i, _, _ in chunks)

    async def chunk_count(accession_number):
        return len(stored.get(accession_number, ()))

    async def one_batch_only(day, cap, amount):
        budget["left"] -= 1
        return budget["left"] >= 0

    monkeypatch.setattr(embeddings, "_get_client", lambda: FakeClient())
    monkeypatch.setattr(database, "insert_chunks", insert_chunks)
    monkeypatch.setattr(database, "chunk_count", chunk_count)
    monkeypatch.setattr(database, "increment_embedding_usage", one_batch_only)
    monkeypatch.setattr(embeddings, "plan_batches", lambda texts, budget=0: [
        texts[: len(texts) // 2],
        texts[len(texts) // 2 :],
    ])

    text = "x" * (embeddings.CHUNK_STRIDE * 4)
    with pytest.raises(embeddings.EmbeddingRequestQuotaError):
        await embeddings.index_filing("acc", text, pacer=embeddings.TokenPacer())

    assert stored["acc"], "the first batch must survive the refusal of the second"
