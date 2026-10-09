import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.routers import analysis as analysis_router
from app.routers import companies as companies_router
from app.services import database, embeddings, retrieval
from app.services.llm import LLMError, LLMQuotaError


client = TestClient(app, raise_server_exceptions=False)

NEW = "0000320193-25-000079"
OLD = "0000320193-24-000123"

FILINGS = [
    {"analysis_id": 7, "accession_number": NEW, "form_type": "10-K", "filing_date": "2025-10-31"},
    {"analysis_id": 3, "accession_number": OLD, "form_type": "10-K", "filing_date": "2024-11-01"},
]

# What match_company_chunks returns: the best three of each filing, best first overall.
CANDIDATES = [
    {"accession_number": NEW, "chunk_index": 40, "content": "Greater China fell. " + "x" * 400, "similarity": 0.91},
    {"accession_number": NEW, "chunk_index": 41, "content": "New 41", "similarity": 0.90},
    {"accession_number": NEW, "chunk_index": 42, "content": "New 42", "similarity": 0.89},
    {"accession_number": OLD, "chunk_index": 38, "content": "Old 38", "similarity": 0.80},
    {"accession_number": OLD, "chunk_index": 39, "content": "Old 39", "similarity": 0.79},
    {"accession_number": OLD, "chunk_index": 12, "content": "Old 12", "similarity": 0.70},
]

QUESTION = {"question": "How did Greater China net sales change?"}


@pytest.fixture
def mock_company_ask(monkeypatch):
    calls: dict = {"scope_ciks": []}

    async def scope(cik, limit):
        calls["scope_ciks"].append(cik)
        calls["scope_limit"] = limit
        return FILINGS

    async def quota_ok(day, cap):
        calls["quota"] = calls.get("quota", 0) + 1
        return calls["quota"] <= cap

    async def embed_ok(texts, task_type):
        calls["task_type"] = task_type
        return [[0.1] * 768 for _ in texts]

    async def match_ok(cik, embedding, per_filing, filings):
        calls["match"] = (cik, per_filing, filings)
        return CANDIDATES

    async def scale_chunks_ok(accession_number, near_chunk_index, limit=3):
        calls.setdefault("scale_anchors", {})[accession_number] = near_chunk_index
        return ["(amounts in millions)"] if accession_number == NEW else []

    async def answer_ok(question, excerpts):
        calls["excerpts"] = excerpts
        return "The 10-K filed 2025-10-31 says it fell (excerpt 1); so did 2024's (excerpt 4)."

    monkeypatch.setattr(database, "company_indexed_filings", scope)
    monkeypatch.setattr(database, "increment_daily_usage", quota_ok)
    monkeypatch.setattr(embeddings, "embed_texts", embed_ok)
    monkeypatch.setattr(database, "match_company_chunks", match_ok)
    monkeypatch.setattr(database, "find_scale_chunks", scale_chunks_ok)
    monkeypatch.setattr(companies_router, "answer_company_question", answer_ok)
    return calls


# --- select_balanced ---

def _rows(*pairs):
    return [{"f": f, "s": s} for f, s in pairs]


def _pick(rows, **kw):
    return retrieval.select_balanced(rows, lambda r: r["f"], lambda r: r["s"], **kw)


def test_select_balanced_caps_each_filing_and_fills_from_the_rest():
    rows = _rows(("a", 0.9), ("a", 0.89), ("a", 0.88), ("a", 0.87), ("b", 0.5), ("b", 0.4), ("b", 0.3))
    picked = _pick(rows)
    assert [(r["f"], r["s"]) for r in picked] == [
        ("a", 0.9), ("a", 0.89), ("a", 0.88), ("b", 0.5), ("b", 0.4), ("b", 0.3)
    ]


def test_select_balanced_is_plain_top_k_when_no_filing_hits_the_cap():
    rows = _rows(("a", 0.9), ("b", 0.8), ("c", 0.7), ("a", 0.6), ("b", 0.5), ("c", 0.4), ("d", 0.3))
    assert [r["s"] for r in _pick(rows)] == [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]


def test_select_balanced_returns_fewer_than_k_when_the_cap_runs_out():
    rows = _rows(("a", 0.9), ("a", 0.8), ("a", 0.7), ("a", 0.6), ("b", 0.5))
    assert [(r["f"], r["s"]) for r in _pick(rows)] == [("a", 0.9), ("a", 0.8), ("a", 0.7), ("b", 0.5)]


def test_select_balanced_sorts_unordered_input():
    rows = _rows(("b", 0.2), ("a", 0.9), ("b", 0.8))
    assert [r["s"] for r in _pick(rows, k=2)] == [0.9, 0.8]


# --- POST /api/companies/{cik}/ask ---

def test_company_ask_answers_across_filings_with_labelled_sources(mock_company_ask):
    resp = client.post("/api/companies/320193/ask", json=QUESTION)
    assert resp.status_code == 200
    body = resp.json()

    assert body["answer"].startswith("The 10-K filed 2025-10-31")
    sources = body["sources"]
    assert [(s["analysis_id"], s["chunk_index"]) for s in sources] == [
        (7, 40), (7, 41), (7, 42), (3, 38), (3, 39), (3, 12)
    ]
    assert sources[0]["filing_date"] == "2025-10-31"
    assert sources[3]["filing_date"] == "2024-11-01"
    assert len(sources[0]["excerpt"]) == 300
    assert mock_company_ask["excerpts"][0].text == CANDIDATES[0]["content"]
    assert mock_company_ask["task_type"] == "RETRIEVAL_QUERY"
    assert mock_company_ask["match"] == ("320193", 3, 6)


def test_company_ask_reads_each_filings_own_scale(mock_company_ask):
    resp = client.post("/api/companies/320193/ask", json=QUESTION)
    sources = resp.json()["sources"]
    assert sources[0]["unit_scale"] == "Amounts in millions."
    assert sources[3]["unit_scale"] is None
    assert [e.unit_scale for e in mock_company_ask["excerpts"]][2:4] == ["Amounts in millions.", None]
    # Anchored on each filing's own best match, as the per-filing ask anchors on its top chunk.
    assert mock_company_ask["scale_anchors"] == {NEW: 40, OLD: 38}


def test_company_ask_normalises_a_padded_cik(mock_company_ask):
    """analyses.cik is stored unpadded, so a padded CIK would otherwise find no filings."""
    resp = client.post("/api/companies/0000320193/ask", json=QUESTION)
    assert resp.status_code == 200
    assert mock_company_ask["scope_ciks"] == ["320193"]


@pytest.mark.parametrize("cik", ["abc", "12345678901"])
def test_company_ask_rejects_a_bad_cik(cik, mock_company_ask):
    assert client.post(f"/api/companies/{cik}/ask", json=QUESTION).status_code == 422


@pytest.mark.parametrize("question", ["", "ab", "x" * 301])
def test_company_ask_rejects_bad_questions(question, mock_company_ask):
    resp = client.post("/api/companies/320193/ask", json={"question": question})
    assert resp.status_code == 422


@pytest.mark.parametrize("filings", [[], FILINGS[:1]])
def test_company_ask_below_two_filings_is_404_before_any_quota(monkeypatch, mock_company_ask, filings):
    async def few(cik, limit):
        return filings

    monkeypatch.setattr(database, "company_indexed_filings", few)
    resp = client.post("/api/companies/320193/ask", json=QUESTION)
    assert resp.status_code == 404
    assert "at least two indexed filings" in resp.json()["detail"]
    assert "quota" not in mock_company_ask


def test_company_ask_skips_a_filing_indexed_after_the_scope_was_read(monkeypatch, mock_company_ask):
    stray = {"accession_number": "0000320193-26-000001", "chunk_index": 1, "content": "c", "similarity": 0.99}

    async def match(cik, embedding, per_filing, filings):
        return [stray, *CANDIDATES]

    monkeypatch.setattr(database, "match_company_chunks", match)
    resp = client.post("/api/companies/320193/ask", json=QUESTION)
    assert resp.status_code == 200
    assert stray["accession_number"] not in {s["accession_number"] for s in resp.json()["sources"]}


def test_company_ask_without_matches_is_404(monkeypatch, mock_company_ask):
    async def none(cik, embedding, per_filing, filings):
        return []

    monkeypatch.setattr(database, "match_company_chunks", none)
    assert client.post("/api/companies/320193/ask", json=QUESTION).status_code == 404


def test_company_ask_consumes_the_daily_cap(monkeypatch, mock_company_ask):
    monkeypatch.setattr(settings, "daily_analysis_cap", 0)
    resp = client.post("/api/companies/320193/ask", json=QUESTION)
    assert resp.status_code == 503
    assert resp.headers["Retry-After"] == "3600"


def test_company_ask_llm_quota_is_503_with_retry_after(monkeypatch, mock_company_ask):
    async def quota(question, excerpts):
        raise LLMQuotaError("quota")

    monkeypatch.setattr(companies_router, "answer_company_question", quota)
    resp = client.post("/api/companies/320193/ask", json=QUESTION)
    assert resp.status_code == 503
    assert resp.headers["Retry-After"] == "60"


def test_company_ask_llm_failure_is_502(monkeypatch, mock_company_ask):
    async def fail(question, excerpts):
        raise LLMError("empty")

    monkeypatch.setattr(companies_router, "answer_company_question", fail)
    assert client.post("/api/companies/320193/ask", json=QUESTION).status_code == 502


def test_company_ask_retrieval_failure_is_502(monkeypatch, mock_company_ask):
    async def boom(cik, embedding, per_filing, filings):
        raise RuntimeError("supabase down")

    monkeypatch.setattr(database, "match_company_chunks", boom)
    assert client.post("/api/companies/320193/ask", json=QUESTION).status_code == 502


def test_company_ask_scope_failure_is_502(monkeypatch, mock_company_ask):
    async def boom(cik, limit):
        raise RuntimeError("supabase down")

    monkeypatch.setattr(database, "company_indexed_filings", boom)
    assert client.post("/api/companies/320193/ask", json=QUESTION).status_code == 502


def test_both_ask_routes_share_one_rate_limit(monkeypatch, mock_company_ask, stored_analysis_row):
    """Both asks spend the same daily unit, so alternating MUST NOT double the per-minute budget."""

    async def get_row(analysis_id):
        return stored_analysis_row

    async def match_one(accession_number, embedding, k):
        return [{"chunk_index": 1, "content": "c"}]

    async def answer(question, excerpts, unit_scale=None):
        return "answer (excerpt 1)"

    monkeypatch.setattr(database, "get_by_id", get_row)
    monkeypatch.setattr(database, "match_chunks", match_one)
    monkeypatch.setattr(analysis_router, "answer_question", answer)

    for i in range(6):
        url = "/api/companies/320193/ask" if i % 2 else "/api/analysis/1/ask"
        assert client.post(url, json=QUESTION).status_code == 200, i
    assert client.post("/api/companies/320193/ask", json=QUESTION).status_code == 429
    assert client.post("/api/analysis/1/ask", json=QUESTION).status_code == 429


# --- GET /api/companies/{cik}/ask-scope ---

def test_ask_scope_lists_filings_newest_first(mock_company_ask):
    resp = client.get("/api/companies/0000320193/ask-scope")
    assert resp.status_code == 200
    body = resp.json()
    assert body["eligible"] is True
    assert [f["analysis_id"] for f in body["filings"]] == [7, 3]
    assert mock_company_ask["scope_ciks"] == ["320193"]
    assert mock_company_ask["scope_limit"] == retrieval.MAX_FILINGS


def test_ask_scope_with_one_filing_is_not_eligible_and_spends_nothing(monkeypatch, mock_company_ask):
    async def one(cik, limit):
        return FILINGS[:1]

    monkeypatch.setattr(database, "company_indexed_filings", one)
    body = client.get("/api/companies/320193/ask-scope").json()
    assert body["eligible"] is False
    assert body["filings"][0]["analysis_id"] == 7
    assert "quota" not in mock_company_ask


def test_ask_scope_is_cached(mock_company_ask):
    client.get("/api/companies/320193/ask-scope")
    client.get("/api/companies/0320193/ask-scope")
    assert mock_company_ask["scope_ciks"] == ["320193"]


def test_ask_scope_failure_is_502_and_not_cached(monkeypatch, mock_company_ask):
    working = database.company_indexed_filings

    async def boom(cik, limit):
        raise RuntimeError("supabase down")

    monkeypatch.setattr(database, "company_indexed_filings", boom)
    assert client.get("/api/companies/320193/ask-scope").status_code == 502
    monkeypatch.setattr(database, "company_indexed_filings", working)
    assert client.get("/api/companies/320193/ask-scope").json()["eligible"] is True


def test_ask_scope_rejects_a_bad_cik(mock_company_ask):
    assert client.get("/api/companies/abc/ask-scope").status_code == 422


# --- RPC wrappers ---

class _FakeClient:
    def __init__(self, seen):
        self.seen = seen

    def rpc(self, name, params):
        self.seen[name] = params
        return type("Q", (), {"execute": lambda _self: type("R", (), {"data": []})()})()


def test_company_rpcs_pass_their_params(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(database, "_get_client", lambda: _FakeClient(seen))

    assert database._company_indexed_filings_sync("320193", 6) == []
    assert database._match_company_chunks_sync("320193", [0.1, 0.2], 3, 6) == []

    assert seen["company_indexed_filings"] == {"p_cik": "320193", "p_limit": 6}
    assert seen["match_company_chunks"] == {
        "p_cik": "320193",
        "p_embedding": [0.1, 0.2],
        "p_per_filing": 3,
        "p_filings": 6,
    }
