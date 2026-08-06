import datetime

from fastapi.testclient import TestClient

from app import quota
from app.config import settings
from app.main import app
from app.services import database


client = TestClient(app, raise_server_exceptions=False)

PAYLOAD = {
    "accession_number": "0000320193-25-000057",
    "cik": "320193",
    "ticker": "AAPL",
    "company_name": "Apple Inc.",
    "form_type": "10-Q",
    "filing_date": "2025-05-02",
    "primary_document": "aapl-q2.htm",
}


# --- security headers ---

def test_security_headers_on_api_responses():
    resp = client.get("/api/health")
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
    assert resp.headers["X-Frame-Options"] == "DENY"
    assert resp.headers["Referrer-Policy"] == "no-referrer"
    assert "max-age" in resp.headers["Strict-Transport-Security"]
    assert resp.headers["Content-Security-Policy"] == (
        "default-src 'none'; frame-ancestors 'none'"
    )


def test_docs_page_exempt_from_api_csp():
    resp = client.get("/docs")
    assert resp.status_code == 200
    assert "Content-Security-Policy" not in resp.headers
    # ...but still gets the base security headers
    assert resp.headers["X-Content-Type-Options"] == "nosniff"


# --- request body size limit ---

def test_oversized_body_is_413():
    body = b"x" * (settings.max_request_bytes + 1)
    resp = client.post(
        "/api/analysis", content=body, headers={"Content-Type": "application/json"}
    )
    assert resp.status_code == 413


def test_normal_body_passes_size_limit(mock_pipeline):
    resp = client.post("/api/analysis", json=PAYLOAD)
    assert resp.status_code == 200


# --- global daily analysis cap ---

def test_daily_cap_exhaustion_is_503(monkeypatch, mock_pipeline):
    monkeypatch.setattr(settings, "daily_analysis_cap", 1)
    first = client.post("/api/analysis", json=PAYLOAD)
    assert first.status_code == 200

    second_filing = {**PAYLOAD, "accession_number": "0000320193-25-000058"}
    second = client.post("/api/analysis", json=second_filing)
    assert second.status_code == 503
    assert second.headers["Retry-After"] == "3600"
    assert mock_pipeline["llm"] == 1  # capped request never reached the LLM


def test_cache_hits_do_not_consume_cap(monkeypatch, mock_pipeline, stored_analysis_row):
    monkeypatch.setattr(settings, "daily_analysis_cap", 0)

    async def cache_hit(accession):
        return stored_analysis_row

    monkeypatch.setattr(database, "get_by_accession", cache_hit)
    resp = client.post("/api/analysis", json=PAYLOAD)
    assert resp.status_code == 200


# --- request ID (roadmap 3.2) ---

def test_response_carries_generated_request_id():
    resp = client.get("/api/health")
    rid = resp.headers["X-Request-ID"]
    assert len(rid) == 12 and rid.isalnum()


def test_valid_supplied_request_id_is_echoed():
    resp = client.get("/api/health", headers={"X-Request-ID": "my-trace-id-123"})
    assert resp.headers["X-Request-ID"] == "my-trace-id-123"


def test_invalid_request_id_is_replaced_not_echoed():
    hostile = "x" * 500
    resp = client.get("/api/health", headers={"X-Request-ID": hostile})
    assert resp.headers["X-Request-ID"] != hostile
    assert len(resp.headers["X-Request-ID"]) == 12


def test_cap_resets_on_new_day(monkeypatch):
    monkeypatch.setattr(settings, "daily_analysis_cap", 1)
    yesterday = datetime.datetime.now(datetime.timezone.utc).date() - datetime.timedelta(days=1)
    monkeypatch.setattr(quota, "_day", yesterday)
    monkeypatch.setattr(quota, "_count", 999)
    assert quota.try_consume() is True
