"""scripts/backfill_segments.py writes to the live database and is never run in CI —
these cover the logic that decides *what* it would touch."""

from pathlib import Path

import pytest

from app.models.schemas import AnalysisResponse, Filing, SegmentRevenue
from app.services import database, edgar
from scripts.backfill_segments import backfill

AAPL_HTML = (Path(__file__).parent / "fixtures" / "segments" / "aapl_10k.htm").read_text()


def _row(id: int, cik: str, ticker: str, accession: str, done: bool = False) -> AnalysisResponse:
    return AnalysisResponse(
        id=id,
        accession_number=accession,
        cik=cik,
        ticker=ticker,
        company_name=f"{ticker} Inc.",
        form_type="10-K",
        filing_date="2025-10-31",
        risk_factors=[],
        segments=SegmentRevenue(period_start="2025-01-01", period_end="2025-12-31") if done else None,
        created_at="2026-07-04T00:00:00+00:00",
    )


def _filing(accession: str) -> Filing:
    dashed = f"{accession[:10]}-{accession[10:12]}-{accession[12:]}"
    return Filing(
        accession_number=dashed,
        filing_date="2025-10-31",
        form_type="10-K",
        primary_document=f"{accession}.htm",
    )


@pytest.fixture
def fake_corpus(monkeypatch):
    """Two AAPL filings, one already read, plus a WKHS one with no breakdown."""
    rows = [
        _row(1, "320193", "AAPL", "000032019325000079"),
        _row(2, "320193", "AAPL", "000032019324000123", done=True),
        _row(3, "1425287", "WKHS", "000162828026022417"),
    ]
    state = {"downloads": [], "writes": {}}

    async def list_analyses(limit, offset, ticker=None):
        page = [r for r in rows if ticker is None or r.ticker == ticker]
        return (page, len(page)) if offset == 0 else ([], len(page))

    async def get_filings(cik, form_types=None, limit=10):
        return [_filing(r.accession_number) for r in rows if r.cik == cik]

    async def fetch_html(cik, accession_number, primary_document):
        assert primary_document == f"{accession_number}.htm"
        state["downloads"].append(accession_number)
        return AAPL_HTML if cik == "320193" else "<html><body>No XBRL.</body></html>"

    async def set_segments(analysis_id, segments):
        state["writes"][analysis_id] = segments

    monkeypatch.setattr(database, "list_analyses", list_analyses)
    monkeypatch.setattr(database, "set_segments", set_segments)
    monkeypatch.setattr(edgar, "get_filings", get_filings)
    monkeypatch.setattr(edgar, "fetch_filing_html", fetch_html)
    return rows, state


async def test_reads_only_rows_never_computed(fake_corpus):
    _, state = fake_corpus
    assert await backfill(ticker=None, limit=None, dry_run=False, every_row=False) == 0
    assert sorted(state["writes"]) == [1, 3]
    assert "000032019324000123" not in state["downloads"]


async def test_all_rereads_every_row(fake_corpus):
    _, state = fake_corpus
    assert await backfill(ticker=None, limit=None, dry_run=False, every_row=True) == 0
    assert sorted(state["writes"]) == [1, 2, 3]


async def test_writes_the_parsed_breakdown_and_an_empty_one(fake_corpus):
    _, state = fake_corpus
    await backfill(ticker=None, limit=None, dry_run=False, every_row=False)
    assert state["writes"][1].segments.total == 416_161_000_000
    # Written, not skipped: an empty breakdown is what stops the next run reading it again.
    assert state["writes"][3] == SegmentRevenue()


async def test_dry_run_writes_nothing(fake_corpus):
    _, state = fake_corpus
    assert await backfill(ticker=None, limit=None, dry_run=True, every_row=False) == 0
    assert state["writes"] == {}


async def test_a_failed_download_reports_nonzero_without_stopping(monkeypatch, fake_corpus):
    _, state = fake_corpus

    async def flaky(cik, accession_number, primary_document):
        if cik == "320193":
            raise RuntimeError("EDGAR down")
        return "<html></html>"

    monkeypatch.setattr(edgar, "fetch_filing_html", flaky)
    assert await backfill(ticker=None, limit=None, dry_run=False, every_row=False) == 1
    assert sorted(state["writes"]) == [3]
