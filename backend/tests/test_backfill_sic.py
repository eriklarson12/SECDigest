"""scripts/backfill_sic.py writes to the live database and is never run in CI —
these cover the logic that decides *what* it would touch."""

import pytest

from app.models.schemas import AnalysisResponse, CompanyProfile
from app.services import database, edgar
from scripts.backfill_sic import _companies_needing_profile, backfill


def _row(cik: str, ticker: str, sic: str | None = None) -> AnalysisResponse:
    return AnalysisResponse(
        id=1,
        accession_number=f"{cik}-x",
        cik=cik,
        ticker=ticker,
        company_name=f"{ticker} Inc.",
        form_type="10-K",
        risk_factors=[],
        sic=sic,
        created_at="2026-07-04T00:00:00+00:00",
    )


APPLE = CompanyProfile(
    cik="0000320193",
    sic="3571",
    sic_description="Electronic Computers",
    owner_org="06 Technology",
)


@pytest.fixture
def fake_corpus(monkeypatch):
    """Two filings for one company plus one for another: 3 analyses, 2 companies."""
    rows = [_row("320193", "AAPL"), _row("320193", "AAPL"), _row("789019", "MSFT")]
    updates: list[tuple[str, CompanyProfile]] = []

    async def list_analyses(limit, offset, ticker=None):
        page = [r for r in rows if ticker is None or r.ticker == ticker]
        return (page, len(page)) if offset == 0 else ([], len(page))

    async def get_profile(cik):
        return APPLE

    async def set_profile(cik, profile):
        updates.append((cik, profile))
        return 1

    monkeypatch.setattr(database, "list_analyses", list_analyses)
    monkeypatch.setattr(database, "set_company_profile", set_profile)
    monkeypatch.setattr(edgar, "get_company_profile", get_profile)
    monkeypatch.setattr(edgar, "close_client", lambda: _noop())
    return rows, updates


async def _noop():
    return None


def test_dedupes_to_distinct_companies():
    """67 analyses cover 50 companies — fetching per filing pays twice for one answer."""
    rows = [_row("320193", "AAPL"), _row("320193", "AAPL"), _row("789019", "MSFT")]
    assert _companies_needing_profile(rows, force=False) == {
        "320193": "AAPL",
        "789019": "MSFT",
    }


def test_already_classified_companies_are_skipped():
    rows = [_row("320193", "AAPL", sic="3571"), _row("789019", "MSFT")]
    assert _companies_needing_profile(rows, force=False) == {"789019": "MSFT"}


def test_force_refetches_classified_companies():
    rows = [_row("320193", "AAPL", sic="3571")]
    assert _companies_needing_profile(rows, force=True) == {"320193": "AAPL"}


async def test_writes_one_update_per_company(fake_corpus):
    _, updates = fake_corpus
    assert await backfill(ticker=None, limit=None, force=False, dry_run=False) == 0
    assert [cik for cik, _ in updates] == ["320193", "789019"]


async def test_dry_run_writes_nothing(fake_corpus):
    _, updates = fake_corpus
    assert await backfill(ticker=None, limit=None, force=False, dry_run=True) == 0
    assert updates == []


async def test_update_uses_the_exact_stored_cik(monkeypatch, fake_corpus):
    """analyses.cik holds whatever the client sent, unpadded. Padding it in the
    `eq()` matches zero rows and the script would report success anyway."""
    _, updates = fake_corpus
    await backfill(ticker=None, limit=None, force=False, dry_run=False)
    assert all(not cik.startswith("0000") for cik, _ in updates)


async def test_unclassified_filer_is_never_written(monkeypatch, fake_corpus):
    """Writing three NULLs would clobber good data on a re-run after a bad day."""
    _, updates = fake_corpus

    async def blank(cik):
        return CompanyProfile(cik=cik.zfill(10))

    monkeypatch.setattr(edgar, "get_company_profile", blank)
    assert await backfill(ticker=None, limit=None, force=False, dry_run=False) == 0
    assert updates == []


async def test_edgar_failure_reports_nonzero_without_stopping(monkeypatch, fake_corpus):
    _, updates = fake_corpus
    seen: list[str] = []

    async def flaky(cik):
        seen.append(cik)
        if cik == "320193":
            raise RuntimeError("EDGAR down")
        return APPLE

    monkeypatch.setattr(edgar, "get_company_profile", flaky)
    assert await backfill(ticker=None, limit=None, force=False, dry_run=False) == 1
    assert seen == ["320193", "789019"]  # kept going
    assert [cik for cik, _ in updates] == ["789019"]
