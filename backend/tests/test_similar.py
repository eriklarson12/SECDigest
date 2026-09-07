"""Language peers (roadmap 9.1): GET /analysis/{id}/similar and the two RPC wrappers behind it.

Coverage note, stated rather than implied: the two rules that make this feature correct — excluding
the subject's own cik, and keeping one filing per peer company — both live in SQL, inside
match_companies. A mocked client cannot reach them. What is verified here is the wrapper contract,
the router's mapping, and the empty/unavailable split; the SQL itself is verified against the live
database (see backend/schema.sql's migration block and the acceptance check in the roadmap)."""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import database, embeddings


client = TestClient(app, raise_server_exceptions=False)


def peer_row(
    analysis_id=2,
    ticker="AMD",
    sic="3674",
    similarity=0.9673,
    pool=56,
):
    return {
        "analysis_id": analysis_id,
        "accession_number": f"00000024884{analysis_id}",
        "ticker": ticker,
        "company_name": "ADVANCED MICRO DEVICES INC",
        "form_type": "10-Q",
        "filing_date": "2026-05-01",
        "sic": sic,
        "sic_description": "Semiconductors & Related Devices",
        "similarity": similarity,
        "pool": pool,
    }


class FakeRPC:
    """Records the RPC name and params the wrapper sends, the way the real client would receive
    them, and hands back whatever `data` the test set."""

    def __init__(self, data):
        self.data = data
        self.calls: list[tuple[str, dict]] = []

    def rpc(self, name, params):
        self.calls.append((name, params))
        return self

    def execute(self):
        return type("Result", (), {"data": self.data})()


# --- the wrappers ---

@pytest.mark.asyncio
async def test_match_companies_sends_the_accession_and_k(monkeypatch):
    fake = FakeRPC([peer_row()])
    monkeypatch.setattr(database, "_get_client", lambda: fake)

    rows = await database.match_companies("000032019325000057", 5)

    assert fake.calls == [
        ("match_companies", {"p_accession": "000032019325000057", "p_k": 5})
    ]
    assert rows[0]["ticker"] == "AMD"


@pytest.mark.asyncio
async def test_match_companies_treats_a_null_result_as_empty(monkeypatch):
    """PostgREST answers a zero-row function with None, not []."""
    monkeypatch.setattr(database, "_get_client", lambda: FakeRPC(None))

    assert await database.match_companies("nosuch", 5) == []


@pytest.mark.asyncio
async def test_upsert_filing_vector_returns_the_chunk_count(monkeypatch):
    fake = FakeRPC(133)
    monkeypatch.setattr(database, "_get_client", lambda: fake)

    assert await database.upsert_filing_vector("acc") == 133
    assert fake.calls == [("upsert_filing_vector", {"p_accession": "acc"})]


@pytest.mark.asyncio
async def test_upsert_filing_vector_reads_a_filing_with_no_chunks_as_zero(monkeypatch):
    monkeypatch.setattr(database, "_get_client", lambda: FakeRPC(None))

    assert await database.upsert_filing_vector("acc") == 0


# --- the endpoint ---

@pytest.fixture
def analysis_found(monkeypatch, stored_analysis_row):
    async def by_id(analysis_id):
        return stored_analysis_row if analysis_id == 1 else None

    monkeypatch.setattr(database, "get_by_id", by_id)


def test_similar_returns_peers_and_the_pool(monkeypatch, analysis_found):
    async def matches(accession_number, k):
        return [peer_row(), peer_row(analysis_id=3, ticker="AVGO", similarity=0.9659)]

    monkeypatch.setattr(database, "match_companies", matches)

    body = client.get("/api/analysis/1/similar").json()

    assert body["pool"] == 56
    assert body["available"] is True
    assert [p["ticker"] for p in body["peers"]] == ["AMD", "AVGO"]
    assert body["peers"][0]["similarity"] == pytest.approx(0.9673)


def test_similar_cleans_the_company_name(monkeypatch, analysis_found):
    """Same treatment the analysis row gets — EDGAR's shouting names are not display copy."""

    async def matches(accession_number, k):
        return [peer_row()]

    monkeypatch.setattr(database, "match_companies", matches)

    name = client.get("/api/analysis/1/similar").json()["peers"][0]["company_name"]
    assert name == "Advanced Micro Devices Inc"


def test_similar_passes_the_limit_through(monkeypatch, analysis_found):
    seen = {}

    async def matches(accession_number, k):
        seen["k"] = k
        return []

    async def has_centroid(accession_number):
        return 133

    monkeypatch.setattr(database, "match_companies", matches)
    monkeypatch.setattr(database, "filing_vector_chunks", has_centroid)

    client.get("/api/analysis/1/similar")
    assert seen["k"] == 5

    client.get("/api/analysis/1/similar?limit=12")
    assert seen["k"] == 12


@pytest.mark.parametrize("limit", ["0", "21", "-1"])
def test_similar_rejects_a_limit_outside_the_range(analysis_found, limit):
    assert client.get(f"/api/analysis/1/similar?limit={limit}").status_code == 422


def test_similar_404s_for_an_unknown_analysis(analysis_found):
    assert client.get("/api/analysis/99/similar").status_code == 404


def test_no_peers_but_a_stored_centroid_is_available_and_empty(monkeypatch, analysis_found):
    """"Nothing sits near this filing" — a real answer, and the card says so."""

    async def matches(accession_number, k):
        return []

    async def has_centroid(accession_number):
        return 133

    monkeypatch.setattr(database, "match_companies", matches)
    monkeypatch.setattr(database, "filing_vector_chunks", has_centroid)

    body = client.get("/api/analysis/1/similar").json()
    assert (body["peers"], body["pool"], body["available"]) == ([], 0, True)


def test_a_filing_without_a_centroid_is_unavailable(monkeypatch, analysis_found):
    """Never indexed, or indexed short. An empty peer list alone cannot say which."""

    async def matches(accession_number, k):
        return []

    async def no_centroid(accession_number):
        return None

    monkeypatch.setattr(database, "match_companies", matches)
    monkeypatch.setattr(database, "filing_vector_chunks", no_centroid)

    assert client.get("/api/analysis/1/similar").json()["available"] is False


def test_the_happy_path_does_not_ask_whether_a_centroid_exists(monkeypatch, analysis_found):
    """One RPC is the whole request; only the empty case pays a second round trip."""

    async def matches(accession_number, k):
        return [peer_row()]

    async def should_not_run(accession_number):
        raise AssertionError("filing_vector_chunks called on the happy path")

    monkeypatch.setattr(database, "match_companies", matches)
    monkeypatch.setattr(database, "filing_vector_chunks", should_not_run)

    assert client.get("/api/analysis/1/similar").status_code == 200


def test_similar_spends_no_embedding_quota(monkeypatch, analysis_found):
    """The feature's whole claim. Ranking reads centroids that were paid for at index time,
    so a lookup must not reach the embedding path at all."""
    calls = {"n": 0}

    async def counted(batch, task_type, pacer):
        calls["n"] += 1
        return []

    async def matches(accession_number, k):
        return [peer_row()]

    monkeypatch.setattr(embeddings, "_embed_batch", counted)
    monkeypatch.setattr(database, "match_companies", matches)

    assert client.get("/api/analysis/1/similar").status_code == 200
    assert calls["n"] == 0


def test_a_peer_sharing_the_subjects_industry_is_not_filtered_out(monkeypatch, analysis_found):
    """The exclusion is by cik, never by sic. Dropping same-industry peers in Python would be
    re-deriving Tier 8, which is the thing this feature exists to offer a second opinion on."""

    async def matches(accession_number, k):
        return [peer_row(sic="3571")]  # the subject fixture's own industry

    monkeypatch.setattr(database, "match_companies", matches)

    assert len(client.get("/api/analysis/1/similar").json()["peers"]) == 1
