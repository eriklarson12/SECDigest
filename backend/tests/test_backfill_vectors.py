"""scripts/backfill_vectors.py writes to the live database and is never run in CI —
these cover the logic that decides *what* it would touch."""

import pytest

import scripts.backfill_vectors as backfill_vectors
from app.models.schemas import AnalysisResponse
from app.services import database
from scripts.backfill_vectors import backfill


def _row(ticker: str, accession: str, chunks_expected: int | None = 100) -> AnalysisResponse:
    return AnalysisResponse(
        id=1,
        accession_number=accession,
        cik="320193",
        ticker=ticker,
        company_name=f"{ticker} Inc.",
        form_type="10-Q",
        risk_factors=[],
        chunks_expected=chunks_expected,
        created_at="2026-07-04T00:00:00+00:00",
    )


@pytest.fixture
def corpus(monkeypatch):
    """Three filings: one complete and uncentroided, one already current, one short.
    The short one is the shape of the single partial filing in the live corpus."""
    rows = [_row("AAPL", "acc-aapl"), _row("MSFT", "acc-msft"), _row("VZ", "acc-vz")]
    indexed = {"acc-aapl": 100, "acc-msft": 100, "acc-vz": 66}
    stored = {"acc-msft": 100}
    written: list[str] = []

    async def list_analyses(limit, offset, ticker=None):
        page = [r for r in rows if ticker is None or r.ticker == ticker]
        return (page, len(page)) if offset == 0 else ([], len(page))

    async def chunk_count(accession_number):
        return indexed[accession_number]

    async def vector_counts():
        return dict(stored)

    async def upsert(accession_number):
        written.append(accession_number)
        return indexed[accession_number]

    monkeypatch.setattr(database, "list_analyses", list_analyses)
    monkeypatch.setattr(database, "chunk_count", chunk_count)
    monkeypatch.setattr(database, "filing_vector_counts", vector_counts)
    monkeypatch.setattr(database, "upsert_filing_vector", upsert)
    return written


@pytest.mark.asyncio
async def test_dry_run_writes_nothing_and_reports_work_outstanding(corpus, monkeypatch):
    async def fail(accession_number):
        raise AssertionError("dry run wrote a centroid")

    monkeypatch.setattr(database, "upsert_filing_vector", fail)

    code = await backfill(None, None, force=False, include_partial=False, dry_run=True)

    # 1, not 0: the short filing is work left to do, and a dry run that found work says so.
    assert code == 1
    assert corpus == []


@pytest.mark.asyncio
async def test_builds_only_the_missing_centroid(corpus):
    code = await backfill(None, None, force=False, include_partial=False, dry_run=False)

    assert corpus == ["acc-aapl"]
    assert code == 1  # VZ is still outstanding


@pytest.mark.asyncio
async def test_a_short_index_is_skipped_by_default(corpus):
    """A centroid over two thirds of a filing would misrepresent it to the whole corpus."""
    await backfill(None, None, force=False, include_partial=False, dry_run=False)

    assert "acc-vz" not in corpus


@pytest.mark.asyncio
async def test_include_partial_accepts_a_short_index(corpus):
    code = await backfill(None, None, force=False, include_partial=True, dry_run=False)

    assert set(corpus) == {"acc-aapl", "acc-vz"}
    assert code == 0


@pytest.mark.asyncio
async def test_a_current_centroid_is_left_alone_without_force(corpus):
    await backfill(None, None, force=False, include_partial=False, dry_run=False)

    assert "acc-msft" not in corpus


@pytest.mark.asyncio
async def test_force_recomputes_a_current_centroid(corpus):
    await backfill(None, None, force=True, include_partial=False, dry_run=False)

    assert "acc-msft" in corpus


@pytest.mark.asyncio
async def test_force_does_not_imply_include_partial(corpus):
    """Two flags, two questions: redoing current work is not the same as accepting
    incomplete language."""
    await backfill(None, None, force=True, include_partial=False, dry_run=False)

    assert "acc-vz" not in corpus


@pytest.mark.asyncio
async def test_ticker_narrows_the_run(corpus):
    code = await backfill("AAPL", None, force=False, include_partial=False, dry_run=False)

    assert corpus == ["acc-aapl"]
    assert code == 0


@pytest.mark.asyncio
async def test_limit_stops_early(corpus):
    await backfill(None, 1, force=False, include_partial=False, dry_run=False)

    assert corpus == ["acc-aapl"]


@pytest.mark.asyncio
async def test_a_filing_with_no_chunks_gets_no_centroid(monkeypatch, corpus):
    async def nothing_indexed(accession_number):
        return 0

    monkeypatch.setattr(database, "chunk_count", nothing_indexed)

    code = await backfill(None, None, force=False, include_partial=True, dry_run=False)

    assert corpus == []
    assert code == 1


@pytest.mark.asyncio
async def test_a_failed_write_does_not_stop_the_run(monkeypatch, corpus):
    async def boom(accession_number):
        raise RuntimeError("supabase down")

    monkeypatch.setattr(database, "upsert_filing_vector", boom)

    code = await backfill(None, None, force=True, include_partial=True, dry_run=False)

    assert code == 1


def test_the_script_opens_no_http_client():
    """The feature's cost claim, made checkable: this backfill spends no Gemini and no EDGAR
    quota because it never talks to either. Its sibling scripts both import edgar and have to
    close its client by hand; an import appearing here would mean that stopped being true."""
    assert not hasattr(backfill_vectors, "edgar")
    assert not hasattr(backfill_vectors, "embeddings")
