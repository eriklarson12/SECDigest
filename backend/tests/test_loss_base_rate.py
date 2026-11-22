"""Net-loss base rates (roadmap 17.3): the dark endpoint and the table writer."""

import json

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from supabase import ClientOptions, create_client

from app.config import settings
from app.main import app
from app.models.schemas import LossBaseRate
from app.services import database

client = TestClient(app, raise_server_exceptions=False)

URL = "/api/companies/{cik}/loss-base-rate"
APPLE = LossBaseRate(cik="320193", calendar_year=2025, probability=0.0282, model_run="2026-11-20")


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(settings, "loss_base_rate_enabled", True)


@pytest.fixture
def reads(monkeypatch):
    """The CIKs the endpoint asked the table for; answers APPLE for Apple, nothing otherwise."""
    asked: list[str] = []

    def read(cik: str) -> LossBaseRate | None:
        asked.append(cik)
        return APPLE if cik == APPLE.cik else None

    monkeypatch.setattr(database, "_get_loss_base_rate_sync", read)
    return asked


# --- disabled (the default) ---

@pytest.mark.parametrize("cik", ["320193", "not-a-cik"])
def test_disabled_is_fastapis_own_404_before_any_read(reads, cik):
    resp = client.get(URL.format(cik=cik))
    assert resp.status_code == 404
    assert resp.json() == {"detail": "Not Found"}
    assert reads == []


def test_the_route_stays_out_of_the_openapi_schema():
    schema = app.openapi()
    assert URL not in schema["paths"]
    assert "LossBaseRate" not in schema["components"]["schemas"]


# --- enabled ---

def test_a_stored_rate_is_returned_for_the_unpadded_cik(enabled, reads):
    resp = client.get(URL.format(cik="0000320193"))
    assert resp.status_code == 200
    assert resp.json() == APPLE.model_dump()
    assert reads == ["320193"]


def test_a_company_without_a_row_is_404(enabled, reads):
    resp = client.get(URL.format(cik="789019"))
    assert resp.status_code == 404
    assert resp.json()["detail"] == "No base rate for this company"


def test_a_malformed_cik_is_422(enabled, reads):
    assert client.get(URL.format(cik="12ab")).status_code == 422
    assert reads == []


def test_a_read_failure_is_502(enabled, monkeypatch):
    def fail(cik: str):
        raise RuntimeError("supabase down")

    monkeypatch.setattr(database, "_get_loss_base_rate_sync", fail)
    resp = client.get(URL.format(cik="320193"))
    assert resp.status_code == 502


def test_a_found_rate_is_cached_and_an_absence_is_not(enabled, reads):
    for cik in ("320193", "320193", "789019", "789019"):
        client.get(URL.format(cik=cik))
    assert reads == ["320193", "789019", "789019"]


# --- replace_loss_base_rates ---

@pytest.fixture
def supabase(monkeypatch):
    """A client on a fake host, past conftest's live-client guard, with every request mocked."""
    host = "https://example.supabase.co"
    monkeypatch.setattr(settings, "supabase_url", host)
    fake = create_client(
        host, "sb_secret_test", options=ClientOptions(httpx_client=database._build_http_client())
    )
    monkeypatch.setattr(database, "_get_client", lambda: fake)
    with respx.mock(base_url=f"{host}/rest/v1") as mock:
        yield mock


def rates(n: int, year: int = 2025) -> list[LossBaseRate]:
    return [
        LossBaseRate(cik=str(i), calendar_year=year, probability=0.5, model_run="2026-11-20")
        for i in range(1, n + 1)
    ]


def test_a_run_is_upserted_in_batches_then_earlier_years_deleted(supabase):
    upsert = supabase.post("/loss_base_rates").mock(return_value=httpx.Response(201))
    delete = supabase.delete("/loss_base_rates").mock(
        return_value=httpx.Response(204, headers={"Content-Range": "*/37"})
    )

    assert database.replace_loss_base_rates(rates(501)) == 37

    assert upsert.call_count == 2
    first, second = (call.request for call in upsert.calls)
    assert len(json.loads(first.content)) == 500
    assert len(json.loads(second.content)) == 1
    assert first.url.params["on_conflict"] == "cik"
    assert "resolution=merge-duplicates" in first.headers["prefer"]
    assert delete.calls.last.request.url.params["calendar_year"] == "lt.2025"


def test_a_run_spanning_two_years_writes_nothing(supabase):
    with pytest.raises(ValueError):
        database.replace_loss_base_rates(rates(1, 2024) + rates(1, 2025))
    assert not supabase.calls
