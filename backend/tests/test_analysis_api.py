import httpx
import pytest
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.config import settings
from app.main import app
from app.routers import analysis as analysis_router
from app.services import database, edgar, embeddings, indexing
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

def test_analysis_schedules_indexing_without_embedding_inline(monkeypatch, mock_pipeline):
    """The handler must not embed — that's what made two analyses collide.
    Any embedding call reached from the request path fails this test; the work belongs to indexing.run_index."""
    seen = {}

    async def capture_run(accession_number, filing_text):
        seen["accession"] = accession_number
        seen["text"] = filing_text

    async def forbidden(*args, **kwargs):
        raise AssertionError("POST /analysis embedded synchronously")

    monkeypatch.setattr(analysis_router.indexing, "run_index", capture_run)
    monkeypatch.setattr(embeddings, "index_filing", forbidden)
    monkeypatch.setattr(embeddings, "embed_texts", forbidden)

    resp = client.post("/api/analysis", json=VALID_PAYLOAD)

    assert resp.status_code == 200
    # The already section-prioritized text is handed off — no second EDGAR fetch
    assert seen["accession"] == "000032019325000057"
    assert seen["text"] == "Total revenue was $1,000 million."


def test_analysis_reports_indexing_before_the_job_runs(
    monkeypatch, mock_pipeline, stored_analysis_row
):
    """mark_scheduled happens in the handler, so the first poll can't miss it."""

    async def never_runs(accession_number, filing_text):
        pass

    async def get_row(analysis_id):
        return stored_analysis_row

    monkeypatch.setattr(analysis_router.indexing, "run_index", never_runs)
    monkeypatch.setattr(database, "get_by_id", get_row)
    client.post("/api/analysis", json=VALID_PAYLOAD)

    resp = client.get("/api/analysis/1/index-status")
    assert resp.status_code == 200
    assert resp.json()["state"] == "indexing"


def test_indexing_failure_never_fails_the_analysis(monkeypatch, mock_pipeline):
    async def index_boom(accession_number, filing_text, *, pacer=None, resume=False):
        raise LLMQuotaError("quota")

    monkeypatch.setattr(embeddings, "index_filing", index_boom)
    resp = client.post("/api/analysis", json=VALID_PAYLOAD)
    assert resp.status_code == 200
    assert resp.json()["revenue_current"] == 1000000000.0


# --- GET /api/analysis/{id}/index-status ---

def test_index_status_reports_coverage(monkeypatch, stored_analysis_row):
    async def get_row(analysis_id):
        return stored_analysis_row

    async def counted(accession_number):
        return 24

    monkeypatch.setattr(database, "get_by_id", get_row)
    monkeypatch.setattr(database, "chunk_count", counted)
    indexing.mark_scheduled(stored_analysis_row.accession_number, 102)

    body = client.get("/api/analysis/1/index-status").json()
    assert body == {"state": "indexing", "chunks_indexed": 24, "chunks_total": 102}


def test_index_status_is_unavailable_when_no_chunks_landed(monkeypatch, stored_analysis_row):
    """A filing from before Q&A shipped, or one whose index stored nothing."""

    async def get_row(analysis_id):
        return stored_analysis_row

    async def empty(accession_number):
        return 0

    monkeypatch.setattr(database, "get_by_id", get_row)
    monkeypatch.setattr(database, "chunk_count", empty)

    body = client.get("/api/analysis/1/index-status").json()
    assert body["state"] == "unavailable"


def test_index_status_404s_for_an_unknown_analysis(monkeypatch):
    async def missing(analysis_id):
        return None

    monkeypatch.setattr(database, "get_by_id", missing)
    assert client.get("/api/analysis/999/index-status").status_code == 404


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

    # Mirrors the RPC: increment first, then compare — so a cap of 0 refuses.
    async def quota_ok(day, cap):
        calls["quota"] = calls.get("quota", 0) + 1
        return calls["quota"] <= cap

    async def embed_ok(texts, task_type):
        calls["task_type"] = task_type
        calls["texts"] = texts
        return [[0.1] * 768 for _ in texts]

    async def match_ok(accession_number, embedding, k):
        calls["accession"] = accession_number
        calls["k"] = k
        return MATCHES

    async def scale_chunks_ok(accession_number, near_chunk_index, limit=3):
        calls["scale_anchor"] = near_chunk_index
        return ["(amounts in millions, except per share data)"]

    async def answer_ok(question, excerpts, unit_scale=None):
        calls["excerpts"] = excerpts
        calls["unit_scale"] = unit_scale
        return "Revenue grew on iPhone demand (excerpt 1)."

    monkeypatch.setattr(database, "get_by_id", get_row)
    monkeypatch.setattr(database, "increment_daily_usage", quota_ok)
    monkeypatch.setattr(embeddings, "embed_texts", embed_ok)
    monkeypatch.setattr(database, "match_chunks", match_ok)
    monkeypatch.setattr(database, "find_scale_chunks", scale_chunks_ok)
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


def test_ask_reports_the_filings_unit_scale(mock_ask):
    """Filings declare scale in a header retrieval rarely returns, so it reaches the model and UI out of band —
    otherwise "$11,133" reads a million times too small."""
    resp = client.post("/api/analysis/1/ask", json={"question": "What drove revenue?"})
    assert resp.status_code == 200
    assert resp.json()["unit_scale"] == "Amounts in millions, except per share data."
    # Same string the caption shows, so answer and caption can't disagree
    assert mock_ask["unit_scale"] == "Amounts in millions, except per share data."
    # Anchored on the closest match, so the governing header wins over the
    # filing's first one (MD&A vs. income statement differ in their exceptions)
    assert mock_ask["scale_anchor"] == MATCHES[0]["chunk_index"]


def test_ask_omits_unit_scale_when_the_filing_declares_none(monkeypatch, mock_ask):
    """No declaration means no caption and no scale line in the prompt — the
    model is told not to guess one rather than handed a default."""

    async def no_scale(accession_number, near_chunk_index, limit=3):
        return []

    monkeypatch.setattr(database, "find_scale_chunks", no_scale)

    resp = client.post("/api/analysis/1/ask", json={"question": "What drove revenue?"})
    assert resp.status_code == 200
    assert resp.json()["unit_scale"] is None
    assert mock_ask["unit_scale"] is None


def test_ask_still_answers_when_the_scale_lookup_fails(monkeypatch, mock_ask):
    """The caption is a nicety; losing it must not cost an answer the user has
    already spent a unit of the daily cap on."""

    async def boom(accession_number, near_chunk_index, limit=3):
        raise RuntimeError("supabase down")

    monkeypatch.setattr(database, "find_scale_chunks", boom)

    resp = client.post("/api/analysis/1/ask", json={"question": "What drove revenue?"})
    assert resp.status_code == 200
    assert resp.json()["unit_scale"] is None
    assert resp.json()["answer"]


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
    async def answer_quota(question, excerpts, unit_scale=None):
        raise LLMQuotaError("quota")

    monkeypatch.setattr(analysis_router, "answer_question", answer_quota)
    resp = client.post("/api/analysis/1/ask", json={"question": "What drove revenue?"})
    assert resp.status_code == 503
    assert resp.headers["Retry-After"] == "60"


def test_ask_llm_failure_is_502(monkeypatch, mock_ask):
    async def answer_fail(question, excerpts, unit_scale=None):
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


def _fake_scale_table(monkeypatch, pages):
    """A filing_chunks table that records each query and replays `pages` in order."""
    seen = []

    class FakeTable:
        def __init__(self):
            self.q = {}

        def select(self, *a, **k):
            return self

        def eq(self, col, val):
            self.q[col] = val
            return self

        def or_(self, filt):
            self.q["or"] = filt
            return self

        def lte(self, col, val):
            self.q["lte"] = (col, val)
            return self

        def order(self, col, desc=False):
            self.q["order"] = (col, desc)
            return self

        def limit(self, n):
            self.q["limit"] = n
            return self

        def execute(self):
            seen.append(self.q)
            return type("R", (), {"data": pages.pop(0)})()

    monkeypatch.setattr(
        database, "_get_client", lambda: type("C", (), {"table": lambda s, n: FakeTable()})()
    )
    return seen


def test_find_scale_chunks_searches_backwards_from_the_anchor(monkeypatch):
    """PostgREST's or_ filter spells its wildcard `*`; with `%` it matches nothing
    and the caption silently disappears — so the filter string is asserted."""
    seen = _fake_scale_table(monkeypatch, [[{"content": "(amounts in millions)"}]])

    rows = database._find_scale_chunks_sync("000090983226000051", 30, 3)

    assert rows == ["(amounts in millions)"]
    assert len(seen) == 1, "a hit above the anchor needs only one round trip"
    assert "content.ilike.*in millions*" in seen[0]["or"]
    assert "%" not in seen[0]["or"]
    assert seen[0]["lte"] == ("chunk_index", 30)
    assert seen[0]["order"] == ("chunk_index", True)  # nearest-preceding first
    assert seen[0]["limit"] == 3


def test_find_scale_chunks_falls_back_to_the_first_declaration(monkeypatch):
    """A chunk above every declaration (cover page, TOC) still gets a scale."""
    seen = _fake_scale_table(monkeypatch, [[], [{"content": "(amounts in millions)"}]])

    rows = database._find_scale_chunks_sync("000090983226000051", 2, 3)

    assert rows == ["(amounts in millions)"]
    assert "lte" not in seen[1], "the fallback searches the whole filing"
    assert seen[1]["order"] == ("chunk_index", False)


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


# --- POST /api/analysis/{id}/reindex ---
# The repair path. POST /api/analysis cannot do this: accession_number is UNIQUE, so a
# re-analysis returns the cached row and the indexer never runs.

@pytest.fixture
def reindexable(monkeypatch, stored_analysis_row):
    """A stored analysis whose filing is still fetchable from EDGAR."""
    state = {"scheduled": [], "expected_written": [], "indexed": 0}

    async def get_row(analysis_id):
        return stored_analysis_row

    async def counted(accession_number):
        return state["indexed"]

    async def resolve(cik, accession_number):
        return "aapl-q2.htm"

    async def fetch_ok(cik, accession_number, primary_document):
        return "x" * (embeddings.CHUNK_STRIDE * 3)

    async def set_expected(accession_number, total):
        state["expected_written"].append(total)

    async def run_index(accession_number, filing_text):
        state["scheduled"].append(accession_number)

    async def budget_ok():
        return 10_000

    monkeypatch.setattr(database, "get_by_id", get_row)
    monkeypatch.setattr(database, "chunk_count", counted)
    monkeypatch.setattr(database, "set_chunks_expected", set_expected)
    monkeypatch.setattr(edgar, "resolve_primary_document", resolve)
    monkeypatch.setattr(edgar, "fetch_filing_text", fetch_ok)
    monkeypatch.setattr(analysis_router.indexing, "run_index", run_index)
    monkeypatch.setattr(analysis_router.quota, "embeddings_remaining", budget_ok)
    return state


def test_reindex_schedules_indexing_for_an_empty_filing(reindexable):
    resp = client.post("/api/analysis/1/reindex")
    assert resp.status_code == 200
    assert resp.json()["state"] == "indexing"
    assert reindexable["scheduled"] == ["000032019325000057"]


def test_reindex_records_the_recomputed_total(reindexable):
    """Repairs a row stored before chunks_expected existed — its NULL total is what
    made a short index look complete in the first place."""
    client.post("/api/analysis/1/reindex")
    assert reindexable["expected_written"] == [3]


def test_reindex_is_a_no_op_once_the_index_is_complete(monkeypatch, reindexable, stored_analysis_row):
    async def complete_row(analysis_id):
        return stored_analysis_row.model_copy(update={"chunks_expected": 3})

    monkeypatch.setattr(database, "get_by_id", complete_row)
    reindexable["indexed"] = 3

    resp = client.post("/api/analysis/1/reindex")
    assert resp.json() == {"state": "complete", "chunks_indexed": 3, "chunks_total": 3}
    assert reindexable["scheduled"] == [], "a complete index must not spend quota"


def test_reindex_refuses_when_the_day_budget_cannot_finish_it(monkeypatch, reindexable):
    """Refusing up front is the whole point: a run that dies mid-filing is what left
    the index short. Better to defer the filing than to strand it again."""

    async def nearly_spent():
        return 1

    monkeypatch.setattr(analysis_router.quota, "embeddings_remaining", nearly_spent)

    resp = client.post("/api/analysis/1/reindex")
    assert resp.status_code == 503
    assert resp.headers["Retry-After"] == "3600"
    assert reindexable["scheduled"] == []


def test_reindex_404s_for_an_unknown_analysis(monkeypatch):
    async def missing(analysis_id):
        return None

    monkeypatch.setattr(database, "get_by_id", missing)
    assert client.post("/api/analysis/999/reindex").status_code == 404


def test_reindex_404s_when_the_filing_left_edgars_recent_block(monkeypatch, reindexable):
    async def gone(cik, accession_number):
        return None

    monkeypatch.setattr(edgar, "resolve_primary_document", gone)
    resp = client.post("/api/analysis/1/reindex")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Filing is no longer listed in EDGAR"
