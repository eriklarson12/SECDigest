"""scripts/backfill_flags.py writes to the live database and is never run in CI —
these cover the logic that decides *what* it would touch."""

import pytest

from app.models.schemas import AnalysisResponse, Filing
from app.services import database, edgar
from scripts.backfill_flags import backfill

GOING_CONCERN = (
    "These conditions collectively raise substantial doubt about the Company's ability to "
    "continue as a going concern."
)


def _row(id: int, cik: str, ticker: str, accession: str) -> AnalysisResponse:
    return AnalysisResponse(
        id=id,
        accession_number=accession,
        cik=cik,
        ticker=ticker,
        company_name=f"{ticker} Inc.",
        form_type="10-K",
        filing_date="2026-03-31",
        risk_factors=[],
        created_at="2026-07-04T00:00:00+00:00",
    )


def _filing(accession: str) -> Filing:
    dashed = f"{accession[:10]}-{accession[10:12]}-{accession[12:]}"
    return Filing(
        accession_number=dashed,
        filing_date="2026-03-31",
        form_type="10-K",
        primary_document=f"{accession}.htm",
    )


@pytest.fixture
def fake_corpus(monkeypatch):
    """Two filings for one company plus one for another, one of them a going concern."""
    rows = [
        _row(1, "320193", "AAPL", "000032019326000001"),
        _row(2, "320193", "AAPL", "000032019326000002"),
        _row(3, "799850", "CRMT", "000162828026048191"),
    ]
    state = {"submissions": [], "writes": {}}

    async def list_analyses(limit, offset, ticker=None):
        page = [r for r in rows if ticker is None or r.ticker == ticker]
        return (page, len(page)) if offset == 0 else ([], len(page))

    async def get_filings(cik, form_types=None, limit=10):
        state["submissions"].append(cik)
        return [_filing(r.accession_number) for r in rows if r.cik == cik]

    async def fetch_text(cik, accession_number, primary_document):
        assert primary_document == f"{accession_number}.htm"
        return GOING_CONCERN if cik == "799850" else "Revenue grew."

    async def set_flags(analysis_id, flags):
        state["writes"][analysis_id] = flags

    monkeypatch.setattr(database, "list_analyses", list_analyses)
    monkeypatch.setattr(database, "set_flags", set_flags)
    monkeypatch.setattr(edgar, "get_filings", get_filings)
    monkeypatch.setattr(edgar, "fetch_filing_plain_text", fetch_text)
    monkeypatch.setattr(edgar, "close_client", lambda: _noop())
    return rows, state


async def _noop():
    return None


async def test_reads_each_company_feed_once_and_writes_every_row(fake_corpus):
    _, state = fake_corpus
    assert await backfill(ticker=None, limit=None, dry_run=False) == 0
    assert state["submissions"] == ["320193", "799850"]
    assert sorted(state["writes"]) == [1, 2, 3]


async def test_a_clean_filing_is_written_as_an_empty_list(fake_corpus):
    # '[]' is also the default, but a rerun after a detector change must be able to clear a flag.
    _, state = fake_corpus
    await backfill(ticker=None, limit=None, dry_run=False)
    assert state["writes"][1] == []
    assert [f.kind for f in state["writes"][3]] == ["going_concern"]
    assert state["writes"][3][0].accession_number == "000162828026048191"


async def test_dry_run_writes_nothing(fake_corpus):
    _, state = fake_corpus
    assert await backfill(ticker=None, limit=None, dry_run=True) == 0
    assert state["writes"] == {}


async def test_a_filing_gone_from_edgar_reports_nonzero_without_stopping(monkeypatch, fake_corpus):
    rows, state = fake_corpus

    async def missing_first(cik, form_types=None, limit=10):
        return [_filing(r.accession_number) for r in rows[1:] if r.cik == cik]

    monkeypatch.setattr(edgar, "get_filings", missing_first)
    assert await backfill(ticker=None, limit=None, dry_run=False) == 1
    assert sorted(state["writes"]) == [2, 3]


async def test_a_failed_download_reports_nonzero_without_stopping(monkeypatch, fake_corpus):
    _, state = fake_corpus

    async def flaky(cik, accession_number, primary_document):
        if accession_number.endswith("01"):
            raise RuntimeError("EDGAR down")
        return "Revenue grew."

    monkeypatch.setattr(edgar, "fetch_filing_plain_text", flaky)
    assert await backfill(ticker=None, limit=None, dry_run=False) == 1
    assert sorted(state["writes"]) == [2, 3]
