import httpx
import respx
from fastapi.testclient import TestClient

from app import cache as cache_module
from app.cache import TTLCache
from app.main import app


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
