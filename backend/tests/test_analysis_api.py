import httpx
import pytest
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.main import app
from app.routers import analysis as analysis_router
from app.services import database, edgar
from app.services.llm import LLMError, LLMQuotaError


client = TestClient(app, raise_server_exceptions=False)

VALID_PAYLOAD = {
    "accession_number": "0000320193-25-000057",
    "cik": "320193",
    "ticker": "AAPL",
    "company_name": "Apple Inc.",
    "form_type": "10-Q",
    "filing_date": "2025-05-02",
    "primary_document": "aapl-q2.htm",
}


# --- POST /api/analysis ---

def test_cache_hit_skips_llm(monkeypatch, stored_analysis_row, mock_pipeline):
    async def cache_hit(accession):
        return stored_analysis_row

    monkeypatch.setattr(database, "get_by_accession", cache_hit)
    resp = client.post("/api/analysis", json=VALID_PAYLOAD)
    assert resp.status_code == 200
    assert resp.json()["ticker"] == "AAPL"
    assert mock_pipeline["llm"] == 0


def test_happy_path_stores_and_returns(mock_pipeline):
    resp = client.post("/api/analysis", json=VALID_PAYLOAD)
    assert resp.status_code == 200
    assert resp.json()["revenue_current"] == 1000000000.0
    assert mock_pipeline["llm"] == 1


def test_empty_filing_text_is_422(monkeypatch, mock_pipeline):
    async def fetch_empty(cik, accession_number, primary_document):
        return "   \n  "

    monkeypatch.setattr(edgar, "fetch_filing_text", fetch_empty)
    resp = client.post("/api/analysis", json=VALID_PAYLOAD)
    assert resp.status_code == 422


def test_edgar_failure_is_502(monkeypatch, mock_pipeline):
    async def fetch_fail(cik, accession_number, primary_document):
        raise httpx.ConnectError("boom")

    monkeypatch.setattr(edgar, "fetch_filing_text", fetch_fail)
    resp = client.post("/api/analysis", json=VALID_PAYLOAD)
    assert resp.status_code == 502
    assert "EDGAR" in resp.json()["detail"]


def test_llm_failure_is_502(monkeypatch, mock_pipeline):
    async def llm_fail(filing_text, form_type, company_name, ticker):
        raise LLMError("malformed after retry")

    monkeypatch.setattr(analysis_router, "analyze_filing", llm_fail)
    resp = client.post("/api/analysis", json=VALID_PAYLOAD)
    assert resp.status_code == 502


def test_llm_quota_is_503_with_retry_after(monkeypatch, mock_pipeline):
    async def llm_quota(filing_text, form_type, company_name, ticker):
        raise LLMQuotaError("quota")

    monkeypatch.setattr(analysis_router, "analyze_filing", llm_quota)
    resp = client.post("/api/analysis", json=VALID_PAYLOAD)
    assert resp.status_code == 503
    assert resp.headers["Retry-After"] == "60"


# --- input validation (security boundary — fields reach EDGAR URLs) ---

@pytest.mark.parametrize(
    "field,value",
    [
        ("accession_number", "not-an-accession"),
        ("cik", "../etc"),
        ("cik", "320193x"),
        ("primary_document", "../../etc/passwd"),
        ("primary_document", "doc?.htm"),
        ("ticker", "AAPL$"),
        ("form_type", "8-K"),
    ],
)
def test_invalid_fields_rejected(field, value):
    payload = {**VALID_PAYLOAD, field: value}
    resp = client.post("/api/analysis", json=payload)
    assert resp.status_code == 422, field


def test_accession_normalized_dashless(mock_pipeline, monkeypatch):
    seen = {}

    async def capture_cache(accession):
        seen["accession"] = accession
        return None

    monkeypatch.setattr(database, "get_by_accession", capture_cache)
    client.post("/api/analysis", json=VALID_PAYLOAD)
    assert seen["accession"] == "000032019325000057"


# --- database race handling (unit) ---

def test_unique_violation_returns_existing_row(monkeypatch, stored_analysis_row):
    class FakeTable:
        def insert(self, data):
            return self

        def execute(self):
            raise APIError(
                {"message": "duplicate key", "code": "23505", "hint": "", "details": ""}
            )

    class FakeClient:
        def table(self, name):
            return FakeTable()

    monkeypatch.setattr(database, "_get_client", lambda: FakeClient())
    monkeypatch.setattr(
        database, "_get_by_accession_sync", lambda accession: stored_analysis_row
    )
    result = database._create_analysis_sync({"accession_number": "000032019325000057"})
    assert result.id == stored_analysis_row.id


# --- GET endpoints ---

def test_list_uppercases_ticker_filter(monkeypatch):
    seen = {}

    async def fake_list(limit, offset, ticker):
        seen["ticker"] = ticker
        return [], 0

    monkeypatch.setattr(database, "list_analyses", fake_list)
    resp = client.get("/api/analysis", params={"ticker": "aapl"})
    assert resp.status_code == 200
    assert seen["ticker"] == "AAPL"


def test_list_rejects_bad_ticker():
    resp = client.get("/api/analysis", params={"ticker": "a$b"})
    assert resp.status_code == 422


def test_get_missing_analysis_is_404(monkeypatch):
    async def none_by_id(analysis_id):
        return None

    monkeypatch.setattr(database, "get_by_id", none_by_id)
    resp = client.get("/api/analysis/999")
    assert resp.status_code == 404


def test_analyze_rate_limit_trips_at_seven():
    # No mocks needed: the 7th request must be rejected before any work happens,
    # and the first 6 fail fast at the (unmocked, unconfigured) cache step.
    statuses = [client.post("/api/analysis", json=VALID_PAYLOAD).status_code for _ in range(7)]
    assert statuses[-1] == 429
