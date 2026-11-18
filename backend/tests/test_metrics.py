import subprocess
import sys

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY

from app import metrics
from app.config import settings
from app.main import app
from app.models.schemas import CompanyProfile
from app.services import database, edgar, llm

client = TestClient(app, raise_server_exceptions=False)

PROFILE_ROUTE = "/api/companies/{cik}/profile"
FRAME_URL = "https://data.sec.gov/api/xbrl/frames/us-gaap/NetIncomeLoss/USD/CY2025.json"

ANALYSIS_PAYLOAD = {
    "accession_number": "0000320193-25-000057",
    "cik": "320193",
    "ticker": "AAPL",
    "company_name": "Apple Inc.",
    "form_type": "10-Q",
    "filing_date": "2025-05-02",
    "primary_document": "aapl-q2.htm",
}


def sample(name: str, **labels: str) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


def requests_seen(route: str, status: str = "200", method: str = "GET") -> float:
    return sample(
        "http_request_duration_seconds_count", method=method, route=route, status=status
    )


def edgar_attempts(outcome: str, status: str) -> float:
    return sample("edgar_requests_total", outcome=outcome, status=status)


@pytest.fixture
def unclassified_profile(monkeypatch):
    async def profile(cik):
        return CompanyProfile(cik=cik)

    monkeypatch.setattr(edgar, "get_company_profile", profile)


@pytest.fixture
def metrics_token(monkeypatch):
    monkeypatch.setattr(settings, "metrics_token", "s3cret-token")
    return "s3cret-token"


# --- route-template label ---

def test_two_ciks_share_one_route_series(unclassified_profile):
    """A raw-path label is one series per company; the template keeps it to one."""
    before = requests_seen(PROFILE_ROUTE)
    assert client.get("/api/companies/320193/profile").status_code == 200
    assert client.get("/api/companies/789019/profile").status_code == 200

    assert requests_seen(PROFILE_ROUTE) == before + 2
    assert requests_seen("/api/companies/320193/profile") == 0
    assert requests_seen("/api/companies/789019/profile") == 0


def test_every_route_exports_a_zero_series_before_its_first_request():
    """A fresh interpreter, because earlier tests in this process have already hit most routes.
    FastAPI's lazy included routers keep their routes out of `app.routes`; this catches that."""
    script = (
        "import app.main\n"
        "from prometheus_client import generate_latest\n"
        "print(generate_latest().decode())\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, check=True
    )
    for method, route in [
        ("GET", "/api/financials/{cik}"),
        ("POST", "/api/analysis"),
        ("GET", "/api/feeds/{ticker}.atom"),
    ]:
        series = f'http_request_duration_seconds_count{{method="{method}",route="{route}",status="200"}} 0.0'
        assert series in result.stdout


def test_unknown_paths_share_the_unmatched_label():
    before = requests_seen("unmatched", status="404")
    client.get("/wp-login.php")
    client.get("/api/does-not-exist/42")
    assert requests_seen("unmatched", status="404") == before + 2


def test_the_status_label_is_the_response_status():
    before = requests_seen(PROFILE_ROUTE, status="422")
    assert client.get("/api/companies/not-a-cik/profile").status_code == 422
    assert requests_seen(PROFILE_ROUTE, status="422") == before + 1


# --- token guard ---

def test_metrics_is_a_404_when_no_token_is_configured(monkeypatch):
    monkeypatch.setattr(settings, "metrics_token", "")
    assert client.get("/metrics").status_code == 404
    assert client.get("/metrics", headers={"Authorization": "Bearer "}).status_code == 404


@pytest.mark.parametrize(
    "header",
    [None, "Bearer wrong", "s3cret-token", "Basic s3cret-token", "Bearer s3cret-token-and-more"],
)
def test_metrics_is_a_404_without_the_right_token(metrics_token, header):
    headers = {"Authorization": header} if header is not None else {}
    resp = client.get("/metrics", headers=headers)
    assert resp.status_code == 404
    assert resp.json() == {"detail": "Not Found"}


def test_metrics_serves_exposition_text_with_the_token(metrics_token, unclassified_profile):
    client.get("/api/companies/320193/profile")
    resp = client.get("/metrics", headers={"Authorization": f"Bearer {metrics_token}"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    assert f'route="{PROFILE_ROUTE}"' in resp.text
    assert "# TYPE edgar_requests_total counter" in resp.text


def test_metrics_is_not_in_the_openapi_schema():
    assert "/metrics" not in app.openapi()["paths"]


# --- EDGAR counters ---

@respx.mock
async def test_an_edgar_success_counts_one_ok_attempt():
    respx.get(FRAME_URL).mock(return_value=httpx.Response(200, json={"data": []}))
    before = edgar_attempts("ok", "2xx")
    await edgar._get_with_retry(FRAME_URL, timeout=5)
    assert edgar_attempts("ok", "2xx") == before + 1


@respx.mock
async def test_an_edgar_429_counts_as_a_retried_attempt():
    respx.get(FRAME_URL).mock(
        side_effect=[httpx.Response(429), httpx.Response(200, json={"data": []})]
    )
    retried, ok = edgar_attempts("retried", "429"), edgar_attempts("ok", "2xx")
    await edgar._get_with_retry(FRAME_URL, timeout=5)
    assert edgar_attempts("retried", "429") == retried + 1
    assert edgar_attempts("ok", "2xx") == ok + 1


@respx.mock
async def test_a_final_edgar_403_counts_as_failed():
    respx.get(FRAME_URL).mock(return_value=httpx.Response(403))
    retried, failed = edgar_attempts("retried", "403"), edgar_attempts("failed", "403")
    with pytest.raises(httpx.HTTPStatusError):
        await edgar._get_with_retry(FRAME_URL, timeout=5)
    assert edgar_attempts("retried", "403") == retried + 2
    assert edgar_attempts("failed", "403") == failed + 1


@respx.mock
async def test_an_edgar_404_is_a_4xx_not_a_block_signal():
    respx.get(FRAME_URL).mock(return_value=httpx.Response(404))
    before = edgar_attempts("failed", "4xx")
    with pytest.raises(httpx.HTTPStatusError):
        await edgar._get_with_retry(FRAME_URL, timeout=5)
    assert edgar_attempts("failed", "4xx") == before + 1


def test_every_edgar_label_pair_is_exported_before_its_first_request():
    """Prometheus cannot see a series go from absent to 1, so the 429 series must exist at 0."""
    exposed = {
        (s.labels["outcome"], s.labels["status"])
        for family in REGISTRY.collect()
        if family.name == "edgar_requests"
        for s in family.samples
        if s.name == "edgar_requests_total"
    }
    assert ("retried", "429") in exposed
    assert ("failed", "403") in exposed
    assert len(exposed) == len(metrics.EDGAR_OUTCOMES) * len(metrics.EDGAR_STATUSES)


def test_every_edgar_status_maps_to_an_exported_label():
    for code in (None, 200, 301, 403, 404, 429, 500, 503):
        assert metrics.edgar_status(code) in metrics.EDGAR_STATUSES


async def test_each_pacing_slot_is_observed():
    before = sample("edgar_pace_wait_seconds_count")
    await edgar._pace()
    await edgar._pace()
    assert sample("edgar_pace_wait_seconds_count") == before + 2


# --- LLM and analysis cache counters ---

class _FakeModels:
    def __init__(self, error: Exception | None):
        self.error = error

    async def generate_content(self, *, model, contents, config):
        if self.error is not None:
            raise self.error
        return object()


class _FakeClient:
    def __init__(self, error: Exception | None = None):
        self.aio = type("Aio", (), {"models": _FakeModels(error)})()


class _QuotaError(Exception):
    code = 429


async def test_a_gemini_call_is_counted_by_model_and_outcome(monkeypatch):
    monkeypatch.setattr(llm, "_get_client", lambda: _FakeClient())
    before = sample("llm_requests_total", model="m-ok", outcome="ok")
    await llm._generate("m-ok", "prompt", None)  # pyright: ignore[reportArgumentType]
    assert sample("llm_requests_total", model="m-ok", outcome="ok") == before + 1


async def test_a_gemini_429_is_counted_as_quota(monkeypatch):
    monkeypatch.setattr(llm, "_get_client", lambda: _FakeClient(_QuotaError()))
    before = sample("llm_requests_total", model="m-quota", outcome="quota")
    with pytest.raises(llm.LLMQuotaError):
        await llm._generate("m-quota", "prompt", None)  # pyright: ignore[reportArgumentType]
    assert sample("llm_requests_total", model="m-quota", outcome="quota") == before + 1


def test_an_analysis_cache_miss_is_counted(mock_pipeline):
    before = sample("analysis_cache_total", result="miss")
    assert client.post("/api/analysis", json=ANALYSIS_PAYLOAD).status_code == 200
    assert sample("analysis_cache_total", result="miss") == before + 1


def test_an_analysis_cache_hit_is_counted(monkeypatch, mock_pipeline, stored_analysis_row):
    async def cached(accession):
        return stored_analysis_row

    monkeypatch.setattr(database, "get_by_accession", cached)
    before = sample("analysis_cache_total", result="hit")
    assert client.post("/api/analysis", json=ANALYSIS_PAYLOAD).status_code == 200
    assert sample("analysis_cache_total", result="hit") == before + 1
    assert mock_pipeline["llm"] == 0
