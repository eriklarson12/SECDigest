import httpx
import pytest
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.config import settings
from app.main import app
from app.routers import analysis as analysis_router
from app.services import database, edgar, embeddings
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


# --- Q&A indexing on analysis creation (roadmap 5.1) ---

def test_analysis_indexes_the_filing_text_for_qa(monkeypatch, mock_pipeline):
    seen = {}

    async def capture_index(accession_number, filing_text):
        seen["accession"] = accession_number
        seen["text"] = filing_text
        return 1

    monkeypatch.setattr(embeddings, "index_filing", capture_index)
    resp = client.post("/api/analysis", json=VALID_PAYLOAD)
    assert resp.status_code == 200
    # The already section-prioritized text is indexed — no second EDGAR fetch
    assert seen["accession"] == "000032019325000057"
    assert seen["text"] == "Total revenue was $1,000 million."


def test_indexing_failure_never_fails_the_analysis(monkeypatch, mock_pipeline):
    async def index_boom(accession_number, filing_text):
        raise LLMQuotaError("quota")

    monkeypatch.setattr(embeddings, "index_filing", index_boom)
    resp = client.post("/api/analysis", json=VALID_PAYLOAD)
    assert resp.status_code == 200
    assert resp.json()["revenue_current"] == 1000000000.0


def test_cache_hit_skips_indexing(monkeypatch, stored_analysis_row, mock_pipeline):
    async def cache_hit(accession):
        return stored_analysis_row

    monkeypatch.setattr(database, "get_by_accession", cache_hit)
    client.post("/api/analysis", json=VALID_PAYLOAD)
    assert mock_pipeline["index"] == 0


# --- POST /api/analysis/{id}/ask ---

MATCHES = [
    {"chunk_index": 4, "content": "Revenue grew on iPhone demand. " + "x" * 400},
    {"chunk_index": 9, "content": "Services revenue reached an all-time high."},
]


@pytest.fixture
def mock_ask(monkeypatch, stored_analysis_row):
    """Mock the ask path: load analysis → embed question → match → answer."""
    calls = {}

    async def get_row(analysis_id):
        return stored_analysis_row

    async def embed_ok(texts, task_type):
        calls["task_type"] = task_type
        calls["texts"] = texts
        return [[0.1] * 768 for _ in texts]

    async def match_ok(accession_number, embedding, k):
        calls["accession"] = accession_number
        calls["k"] = k
        return MATCHES

    async def answer_ok(question, excerpts):
        calls["excerpts"] = excerpts
        return "Revenue grew on iPhone demand (excerpt 1)."

    monkeypatch.setattr(database, "get_by_id", get_row)
    monkeypatch.setattr(embeddings, "embed_texts", embed_ok)
    monkeypatch.setattr(database, "match_chunks", match_ok)
    monkeypatch.setattr(analysis_router, "answer_question", answer_ok)
    return calls


def test_ask_returns_answer_with_cited_sources(mock_ask):
    resp = client.post("/api/analysis/1/ask", json={"question": "What drove revenue?"})
    assert resp.status_code == 200

    body = resp.json()
    assert body["answer"] == "Revenue grew on iPhone demand (excerpt 1)."
    assert [s["chunk_index"] for s in body["sources"]] == [4, 9]
    # Excerpts are trimmed for the UI, but the LLM sees the full chunk
    assert len(body["sources"][0]["excerpt"]) == 300
    assert mock_ask["excerpts"][0] == MATCHES[0]["content"]
    assert mock_ask["task_type"] == "RETRIEVAL_QUERY"
    assert mock_ask["accession"] == "000032019325000057"
    assert mock_ask["k"] == 6


@pytest.mark.parametrize("question", ["", "  ", "ab", "x" * 301])
def test_ask_rejects_bad_questions(question, mock_ask):
    resp = client.post("/api/analysis/1/ask", json={"question": question})
    assert resp.status_code == 422


def test_ask_unknown_analysis_is_404(monkeypatch, mock_ask):
    async def none_by_id(analysis_id):
        return None

    monkeypatch.setattr(database, "get_by_id", none_by_id)
    resp = client.post("/api/analysis/999/ask", json={"question": "What drove revenue?"})
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Analysis not found"


def test_ask_without_chunks_is_404(monkeypatch, mock_ask):
    """Filings analyzed before 5.1 shipped have no chunks."""

    async def no_matches(accession_number, embedding, k):
        return []

    monkeypatch.setattr(database, "match_chunks", no_matches)
    resp = client.post("/api/analysis/1/ask", json={"question": "What drove revenue?"})
    assert resp.status_code == 404
    assert "Q&A isn't available" in resp.json()["detail"]


def test_ask_llm_quota_is_503_with_retry_after(monkeypatch, mock_ask):
    async def answer_quota(question, excerpts):
        raise LLMQuotaError("quota")

    monkeypatch.setattr(analysis_router, "answer_question", answer_quota)
    resp = client.post("/api/analysis/1/ask", json={"question": "What drove revenue?"})
    assert resp.status_code == 503
    assert resp.headers["Retry-After"] == "60"


def test_ask_llm_failure_is_502(monkeypatch, mock_ask):
    async def answer_fail(question, excerpts):
        raise LLMError("empty answer")

    monkeypatch.setattr(analysis_router, "answer_question", answer_fail)
    resp = client.post("/api/analysis/1/ask", json={"question": "What drove revenue?"})
    assert resp.status_code == 502


def test_ask_consumes_the_daily_cap(monkeypatch, mock_ask):
    monkeypatch.setattr(settings, "daily_analysis_cap", 0)
    resp = client.post("/api/analysis/1/ask", json={"question": "What drove revenue?"})
    assert resp.status_code == 503
    assert resp.headers["Retry-After"] == "3600"


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


def test_insert_chunks_tolerates_a_concurrent_index(monkeypatch):
    """Two requests indexing the same filing produce equivalent rows."""

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
    # Does not raise
    database._insert_chunks_sync("000032019325000057", [(0, "text", [0.1, 0.2])])


def test_match_chunks_passes_rpc_params(monkeypatch):
    seen = {}

    class FakeQuery:
        def execute(self):
            return type("R", (), {"data": [{"chunk_index": 1, "content": "c"}]})()

    class FakeClient:
        def rpc(self, name, params):
            seen["name"] = name
            seen["params"] = params
            return FakeQuery()

    monkeypatch.setattr(database, "_get_client", lambda: FakeClient())
    rows = database._match_chunks_sync("000032019325000057", [0.1, 0.2], 6)

    assert seen["name"] == "match_chunks"
    assert seen["params"] == {
        "p_accession": "000032019325000057",
        "p_embedding": [0.1, 0.2],
        "p_k": 6,
    }
    assert rows[0]["chunk_index"] == 1


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
