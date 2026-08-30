import logging

import pytest

from app import quota
from app.cache import filings_cache, financials_cache
from app.models.schemas import AnalysisResponse
from app.ratelimit import limiter
from app.routers import analysis as analysis_router
from app.services import database, edgar, embeddings, indexing, llm


@pytest.fixture(autouse=True)
def reset_edgar_state(monkeypatch):
    """Isolate the module-level ticker map and make retries instant."""
    monkeypatch.setattr(edgar, "_ticker_map", [])
    monkeypatch.setattr(edgar, "_RETRY_BASE_DELAY", 0.0)
    yield


@pytest.fixture(autouse=True)
def no_live_gemini(monkeypatch):
    """Fail loudly if a test reaches the real Gemini client.
    Without this, a developer with a populated .env gets a green run that quietly spends live quota. Tests that mean to call Gemini monkeypatch `_get_client` themselves, overriding this."""

    def unpatched_client():
        raise AssertionError(
            "Test reached the real Gemini client — monkeypatch _get_client "
            "(see fake_client in tests/test_embeddings.py)."
        )

    monkeypatch.setattr(llm, "_get_client", unpatched_client)
    monkeypatch.setattr(embeddings, "_get_client", unpatched_client)
    yield


@pytest.fixture(autouse=True)
def no_live_supabase(monkeypatch):
    """Fail loudly if a test reaches the real Supabase client.
    Same hazard as no_live_gemini: config reads .env, so a developer with real credentials would have
    tests writing to the production tables. The daily cap fails open, which would hide it entirely."""

    def unpatched_client():
        raise AssertionError(
            "Test reached the real Supabase client — monkeypatch the database "
            "function it calls (see mock_pipeline)."
        )

    monkeypatch.setattr(database, "_get_client", unpatched_client)
    yield


@pytest.fixture(autouse=True)
def embedding_budget(monkeypatch):
    """Grant the daily embedding budget by default.
    Reservations go through Supabase and fail closed, so without this every embedding test is
    refused before it reaches its fake Gemini client. Tests about exhaustion override these."""

    async def granted(day, cap, amount):
        return True

    async def nothing_spent(day):
        return 0

    monkeypatch.setattr(database, "increment_embedding_usage", granted)
    monkeypatch.setattr(database, "embedding_usage", nothing_spent)
    yield


@pytest.fixture(autouse=True)
def reset_limits():
    """Rate limiter, daily quota, and TTL caches are module state — reset per test."""
    limiter.reset()
    quota.reset()
    filings_cache.clear()
    financials_cache.clear()
    # The background indexer's pacer, lock and status map are process singletons
    indexing.reset()
    yield


@pytest.fixture
def restore_root_logging():
    """configure_logging() mutates the root logger — put it back for later tests."""
    root = logging.getLogger()
    saved = [(handler, handler.formatter, list(handler.filters)) for handler in root.handlers]
    yield
    root.handlers = [handler for handler, _, _ in saved]
    for handler, formatter, filters in saved:
        handler.setFormatter(formatter)
        handler.filters = filters


@pytest.fixture
def mock_pipeline(monkeypatch, stored_analysis_row):
    """Mock cache-miss → fetch → LLM → store happy path; tests override pieces."""
    calls = {"llm": 0, "index": 0, "quota": 0}

    async def no_cache(accession):
        return None

    async def fetch_ok(cik, accession_number, primary_document):
        return "Total revenue was $1,000 million."

    async def llm_ok(filing_text, form_type, company_name, ticker):
        calls["llm"] += 1

        class A:
            class revenue:
                current = 1000000000.0
                yoy_change_pct = 5.5

            class net_income:
                current = 200000000.0
                yoy_change_pct = None

            risk_factors = ["Supply chain concentration risk."]
            management_guidance = "Management expects continued growth."
            summary = "Revenue grew 5.5% year over year."

        return A

    async def store_ok(data):
        return stored_analysis_row

    # Mirrors the RPC's semantics (increment, then compare) so the cap tests
    # still exercise a real budget rather than a stub that always says yes.
    async def quota_ok(day, cap):
        calls["quota"] += 1
        return calls["quota"] <= cap

    # Indexing now runs as a BackgroundTask, which starlette's TestClient still
    # executes after the response — so it needs the paced signature.
    async def index_ok(accession_number, filing_text, *, pacer=None, resume=False):
        calls["index"] += 1
        return 1

    async def chunk_count_ok(accession_number):
        return calls["index"]

    monkeypatch.setattr(database, "get_by_accession", no_cache)
    monkeypatch.setattr(edgar, "fetch_filing_text", fetch_ok)
    monkeypatch.setattr(analysis_router, "analyze_filing", llm_ok)
    monkeypatch.setattr(database, "create_analysis", store_ok)
    monkeypatch.setattr(database, "increment_daily_usage", quota_ok)
    monkeypatch.setattr(database, "chunk_count", chunk_count_ok)
    monkeypatch.setattr(embeddings, "index_filing", index_ok)
    return calls


@pytest.fixture
def tickers_json():
    return {
        "0": {"cik_str": 1090872, "ticker": "A", "title": "Agilent Technologies Inc"},
        "1": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
        "2": {"cik_str": 1652044, "ticker": "GOOGL", "title": "Alphabet Inc."},
    }


@pytest.fixture
def submissions_json():
    # 3 forms but only 2 descriptions — exercises the short-array guard
    return {
        "filings": {
            "recent": {
                "form": ["10-Q", "8-K", "10-K"],
                "accessionNumber": [
                    "0000320193-25-000057",
                    "0000320193-25-000044",
                    "0000320193-24-000123",
                ],
                "filingDate": ["2025-05-02", "2025-04-10", "2024-11-01"],
                "primaryDocument": ["aapl-q2.htm", "aapl-8k.htm", "aapl-10k.htm"],
                "primaryDocDescription": ["10-Q", "8-K"],
            }
        }
    }


@pytest.fixture
def filing_html():
    return """<html><head>
    <style>body { color: red; }</style>
    <script>alert('tracking');</script>
    </head><body>
    <h1>FORM 10-Q</h1>
    <p>Total revenue was $1,000 million for the quarter.</p>
    <p>Net income was $200 million.</p>
    </body></html>"""


@pytest.fixture
def valid_analysis_json():
    return (
        '{"revenue": {"current": 1000000000, "yoy_change_pct": 5.5},'
        ' "net_income": {"current": 200000000, "yoy_change_pct": null},'
        ' "risk_factors": ["Supply chain concentration risk."],'
        ' "management_guidance": "Management expects continued growth.",'
        ' "summary": "Revenue grew 5.5% year over year."}'
    )


@pytest.fixture
def malformed_analysis_json():
    return '{"revenue": "a lot", "oops": true'


@pytest.fixture
def stored_analysis_row():
    return AnalysisResponse(
        id=1,
        accession_number="000032019325000057",
        cik="320193",
        ticker="AAPL",
        company_name="Apple Inc.",
        form_type="10-Q",
        filing_date="2025-05-02",
        revenue_current=1000000000.0,
        revenue_yoy_change_pct=5.5,
        net_income_current=200000000.0,
        net_income_yoy_change_pct=None,
        risk_factors=["Supply chain concentration risk."],
        management_guidance="Management expects continued growth.",
        summary="Revenue grew 5.5% year over year.",
        created_at="2026-07-04T00:00:00+00:00",
    )
