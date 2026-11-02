import httpx
import pytest
import respx

from app.config import settings
from app.services import database

_SKEW = {"code": "PGRST303", "message": "JWT issued at future", "hint": None, "details": None}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(database, "_CLOCK_SKEW_RETRY_SECONDS", 0)
    with database._build_http_client() as c:
        yield c


def _url(path: str) -> str:
    return f"{settings.supabase_url}/rest/v1{path}"


@respx.mock
def test_clock_skew_is_retried_once_and_succeeds(client):
    route = respx.post(_url("/analyses")).mock(
        side_effect=[httpx.Response(401, json=_SKEW), httpx.Response(201, json=[{"id": 1}])]
    )
    response = client.post("/analyses", json={"accession_number": "x"})
    assert response.status_code == 201
    assert route.call_count == 2
    # The resent request carries the same body, so a retried insert writes the same row.
    assert route.calls[1].request.content == route.calls[0].request.content


@respx.mock
def test_clock_skew_twice_surfaces_the_second_rejection(client):
    route = respx.get(_url("/analyses")).mock(return_value=httpx.Response(401, json=_SKEW))
    response = client.get("/analyses")
    assert response.status_code == 401
    assert response.json()["code"] == "PGRST303"
    assert route.call_count == 2


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(401, json={"code": "PGRST301", "message": "JWT expired"}),
        httpx.Response(401, text="not json"),
        httpx.Response(500, json=_SKEW),
        httpx.Response(200, json=[]),
    ],
    ids=["other-auth-error", "non-json-401", "skew-code-on-500", "success"],
)
@respx.mock
def test_anything_else_is_not_retried(client, response):
    route = respx.get(_url("/analyses")).mock(return_value=response)
    assert client.get("/analyses").status_code == response.status_code
    assert route.call_count == 1


def test_the_supabase_client_keeps_http2_off():
    with database._build_http_client() as c:
        transport = c._transport
        assert isinstance(transport, database._ClockSkewRetry)
        assert transport._pool._http2 is False
