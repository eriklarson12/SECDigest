import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app import cache as cache_module
from app.cache import TTLCache
from app.main import app
from app.models.schemas import CompanySearchResult
from app.routers import companies as companies_router
from app.services import edgar


client = TestClient(app, raise_server_exceptions=False)

SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK0000320193.json"


# --- TTLCache unit ---

def test_get_returns_stored_value():
    c = TTLCache(ttl_seconds=100, max_entries=10)
    c.set("k", [1, 2])
    assert c.get("k") == [1, 2]
    assert c.get("missing") is None


def test_ttl_expiry(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(cache_module.time, "monotonic", lambda: now[0])
    c = TTLCache(ttl_seconds=60, max_entries=10)
    c.set("k", "v")
    now[0] += 59
    assert c.get("k") == "v"
    now[0] += 2
    assert c.get("k") is None


def test_max_entries_evicts_oldest_inserted():
    c = TTLCache(ttl_seconds=100, max_entries=2)
    c.set("a", 1)
    c.set("b", 2)
    c.set("c", 3)
    assert c.get("a") is None  # oldest evicted
    assert c.get("b") == 2
    assert c.get("c") == 3


def test_set_existing_key_refreshes_without_evicting():
    c = TTLCache(ttl_seconds=100, max_entries=2)
    c.set("a", 1)
    c.set("b", 2)
    c.set("a", 10)  # update, not a new entry
    assert c.get("a") == 10
    assert c.get("b") == 2


def test_clear():
    c = TTLCache(ttl_seconds=100, max_entries=10)
    c.set("a", 1)
    c.clear()
    assert c.get("a") is None


# --- filings router integration ---

@respx.mock
def test_second_identical_filings_request_served_from_cache(submissions_json):
    route = respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    first = client.get("/api/filings/320193")
    assert first.status_code == 200
    second = client.get("/api/filings/320193")
    assert second.status_code == 200
    assert second.json() == first.json()
    assert route.call_count == 1  # EDGAR hit exactly once


@respx.mock
def test_different_params_miss_the_cache(submissions_json):
    route = respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    client.get("/api/filings/320193")
    client.get("/api/filings/320193?limit=5")
    assert route.call_count == 2


@respx.mock
def test_errors_are_not_cached():
    route = respx.get(SUBMISSIONS_URL).mock(
        side_effect=[httpx.Response(404), httpx.Response(404)]
    )
    assert client.get("/api/filings/320193").status_code == 404
    assert client.get("/api/filings/320193").status_code == 404
    assert route.call_count == 2


@respx.mock
def test_limit_reaches_100_and_stops_there(submissions_json):
    """The company page reads its filing list and its 8-K events out of one response
    (roadmap 9.2), and the deepest measured filer needs 57 rows to reach 10 periodic
    filings. 100 is the headroom over that, not a round number."""
    respx.get(SUBMISSIONS_URL).mock(return_value=httpx.Response(200, json=submissions_json))
    assert client.get("/api/filings/320193?limit=100").status_code == 200
    assert client.get("/api/filings/320193?limit=101").status_code == 422


# --- company profile router integration (roadmap 8.1) ---

@respx.mock
def test_profile_endpoint_returns_the_classification(submissions_json):
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    resp = client.get("/api/companies/320193/profile")
    assert resp.status_code == 200
    assert resp.json() == {
        "cik": "0000320193",
        "sic": "3571",
        "sic_description": "Electronic Computers",
        "owner_org": "06 Technology",
    }


@respx.mock
def test_listing_filings_makes_the_profile_free(submissions_json):
    route = respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    client.get("/api/filings/320193")
    assert client.get("/api/companies/320193/profile").status_code == 200
    assert route.call_count == 1


@respx.mock
def test_unclassified_filer_returns_nulls_not_an_error(unclassified_submissions_json):
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=unclassified_submissions_json)
    )
    body = client.get("/api/companies/320193/profile").json()
    assert (body["sic"], body["sic_description"], body["owner_org"]) == (None, None, None)


def test_profile_rejects_a_malformed_cik():
    assert client.get("/api/companies/not-a-cik/profile").status_code == 422


@respx.mock
def test_profile_edgar_failure_is_502():
    respx.get(SUBMISSIONS_URL).mock(return_value=httpx.Response(404))
    assert client.get("/api/companies/320193/profile").status_code == 502


@respx.mock
def test_profile_response_carries_rate_limit_headers(submissions_json):
    """slowapi injects these into the endpoint's `response` param — an endpoint that
    omits it raises on every request, not only when the limit is hit."""
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    resp = client.get("/api/companies/320193/profile")
    assert "X-RateLimit-Limit" in resp.headers


# --- peers router integration (roadmap 8.3) ---

def _peer(cik, ticker, name):
    return CompanySearchResult(cik=cik, ticker=ticker, name=name)


@pytest.fixture
def stub_peers(monkeypatch):
    """Stands in for the SIC feed. get_peers returns the list uncapped — the router caps."""
    captured = {}

    def stub(peers):
        async def fake(sic):
            captured["sic"] = sic
            return peers

        monkeypatch.setattr(edgar, "get_peers", fake)
        monkeypatch.setattr(edgar, "ticker_map_loaded", lambda: True)
        return captured

    return stub


@respx.mock
def test_peers_endpoint_returns_the_sic_and_its_companies(submissions_json, stub_peers):
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    captured = stub_peers([_peer("2488", "AMD", "Advanced Micro Devices")])

    body = client.get("/api/companies/320193/peers").json()
    assert captured["sic"] == "3571"
    assert body == {
        "cik": "0000320193",
        "sic": "3571",
        "sic_description": "Electronic Computers",
        "peers": [{"cik": "2488", "ticker": "AMD", "name": "Advanced Micro Devices"}],
    }


@respx.mock
def test_peers_are_capped(submissions_json, stub_peers):
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    stub_peers([_peer(str(i), f"T{i}", f"Company {i}") for i in range(50)])

    body = client.get("/api/companies/320193/peers").json()
    assert len(body["peers"]) == companies_router._PEERS_LIMIT
    # The cap keeps the head of the list, which is where market-cap order put the majors.
    assert body["peers"][0]["ticker"] == "T0"


@respx.mock
def test_the_company_is_in_its_own_peer_list(submissions_json, stub_peers):
    """/benchmark seeds from a SIC alone and carries no subject CIK, so dropping self here
    would build a company's benchmark table without the company in it."""
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    stub_peers([_peer("320193", "AAPL", "Apple Inc."), _peer("2488", "AMD", "AMD")])

    body = client.get("/api/companies/320193/peers").json()
    assert [p["ticker"] for p in body["peers"]] == ["AAPL", "AMD"]


@respx.mock
def test_an_unclassified_filer_has_no_peers_and_no_error(unclassified_submissions_json):
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=unclassified_submissions_json)
    )
    resp = client.get("/api/companies/320193/peers")
    assert resp.status_code == 200
    assert resp.json()["sic"] is None
    assert resp.json()["peers"] == []


@respx.mock
def test_a_failing_feed_is_an_empty_list_not_a_5xx(submissions_json, tickers_json):
    """A degraded peer list must not take down the page rendering it. The real get_peers runs
    here — the stub in the tests above cannot show that a 5xx from EDGAR stays inside it."""
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    respx.get("https://www.sec.gov/files/company_tickers.json").mock(
        return_value=httpx.Response(200, json=tickers_json)
    )
    respx.get(url__startswith="https://www.sec.gov/cgi-bin/browse-edgar").mock(
        return_value=httpx.Response(503)
    )

    resp = client.get("/api/companies/320193/peers")
    assert resp.status_code == 200
    # The subject survives a dead feed, so the caller gets a one-row table rather than an
    # error. What it must never get is a 5xx.
    assert resp.json() == {
        "cik": "0000320193",
        "sic": "3571",
        "sic_description": "Electronic Computers",
        "peers": [{"cik": "320193", "ticker": "AAPL", "name": "Apple Inc."}],
    }


@respx.mock
def test_a_failing_profile_is_502_not_an_empty_list():
    """"EDGAR is down" and "this filer has no industry" are different facts. Folding the first
    into the second would be exactly the framing this classification is labelled against."""
    respx.get(SUBMISSIONS_URL).mock(return_value=httpx.Response(404))
    assert client.get("/api/companies/320193/peers").status_code == 502


def test_peers_reject_a_malformed_cik():
    assert client.get("/api/companies/not-a-cik/peers").status_code == 422


@respx.mock
def test_peers_response_carries_rate_limit_headers(submissions_json, stub_peers):
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    stub_peers([])
    resp = client.get("/api/companies/320193/peers")
    assert "X-RateLimit-Limit" in resp.headers


@respx.mock
def test_a_company_missing_from_its_own_industry_is_added(submissions_json, stub_peers, monkeypatch):
    """SIC 7372 is dense enough that the 600 filers EDGAR lists first stop at the letter D,
    so Microsoft is absent from its own peer feed. The subject leads the list regardless."""
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    stub_peers([_peer("2488", "AMD", "Advanced Micro Devices")])
    monkeypatch.setattr(
        edgar, "company_by_cik", lambda cik: _peer("320193", "AAPL", "Apple Inc.")
    )

    body = client.get("/api/companies/320193/peers").json()
    assert [p["ticker"] for p in body["peers"]] == ["AAPL", "AMD"]


@respx.mock
def test_the_subject_is_not_duplicated(submissions_json, stub_peers, monkeypatch):
    """The feed pads CIKs and the map does not, so an int comparison is what stops the
    company being listed beside itself."""
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    stub_peers([_peer("0000320193", "AAPL", "Apple Inc."), _peer("2488", "AMD", "AMD")])
    monkeypatch.setattr(
        edgar, "company_by_cik", lambda cik: _peer("320193", "AAPL", "Apple Inc.")
    )

    body = client.get("/api/companies/320193/peers").json()
    assert [p["ticker"] for p in body["peers"]] == ["AAPL", "AMD"]


@respx.mock
def test_the_subject_outranks_the_cap(submissions_json, stub_peers, monkeypatch):
    """Found deep in a dense code, the subject would be ranked below 20 peers by market cap
    and cut — which is how Microsoft first came back missing from its own industry."""
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    stub_peers(
        [_peer(str(i), f"T{i}", f"Company {i}") for i in range(30)]
        + [_peer("320193", "AAPL", "Apple Inc.")]
    )
    monkeypatch.setattr(
        edgar, "company_by_cik", lambda cik: _peer("320193", "AAPL", "Apple Inc.")
    )

    body = client.get("/api/companies/320193/peers").json()
    assert body["peers"][0]["ticker"] == "AAPL"
    assert len(body["peers"]) == companies_router._PEERS_LIMIT


@respx.mock
def test_a_private_filer_adds_nothing(submissions_json, stub_peers, monkeypatch):
    """Most CIKs under a SIC are unlisted. One asking for its own peers has no ticker row
    to prepend, and must not become a null entry in the list."""
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    stub_peers([_peer("2488", "AMD", "AMD")])
    monkeypatch.setattr(edgar, "company_by_cik", lambda cik: None)

    body = client.get("/api/companies/320193/peers").json()
    assert [p["ticker"] for p in body["peers"]] == ["AMD"]
