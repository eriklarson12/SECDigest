"""Insider activity (roadmap 12.5): the 90-day window, totals, failures and request cost."""

from datetime import date
from pathlib import Path

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app.main import app
from app.services import edgar

client = TestClient(app, raise_server_exceptions=False)

FIXTURES = Path(__file__).parent / "fixtures" / "form4"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK0000320193.json"
ARCHIVES = "https://www.sec.gov/Archives/edgar/data/320193"
TODAY = date(2026, 10, 3)


def submissions(rows: list[tuple[str, str, str]]) -> dict:
    """`rows` are (form, accession, filing date), newest first, as the feed orders them."""
    return {
        "filings": {
            "recent": {
                "form": [form for form, _, _ in rows],
                "accessionNumber": [acc for _, acc, _ in rows],
                "filingDate": [day for _, _, day in rows],
                "primaryDocument": ["xslF345X06/form4.xml"] * len(rows),
                "primaryDocDescription": [""] * len(rows),
                "items": [""] * len(rows),
            }
        }
    }


def mock_form4(accession: str, fixture: str | None, status: int = 200) -> respx.Route:
    body = (FIXTURES / f"{fixture}.xml").read_bytes() if fixture else b""
    return respx.get(f"{ARCHIVES}/{accession.replace('-', '')}/form4.xml").mock(
        return_value=httpx.Response(status, content=body)
    )


ROWS = [
    ("4", "0000000001-26-000001", "2026-10-01"),  # sale
    ("8-K", "0000000001-26-000002", "2026-09-30"),
    ("4", "0000000001-26-000003", "2026-09-17"),  # exercise + sale
    ("4/A", "0000000001-26-000004", "2026-09-10"),
    ("4", "0000000001-26-000005", "2026-08-25"),  # joint, no trades
    ("4", "0000000001-26-000006", "2026-07-06"),  # purchase, 89 days back
    ("4", "0000000001-26-000007", "2026-07-04"),  # outside the window
]


def mock_aapl() -> None:
    respx.get(SUBMISSIONS_URL).mock(return_value=httpx.Response(200, json=submissions(ROWS)))
    mock_form4("0000000001-26-000001", "aapl_sale")
    mock_form4("0000000001-26-000003", "aapl_exercise")
    mock_form4("0000000001-26-000005", "wkhs_joint")
    mock_form4("0000000001-26-000006", "purchase")


@respx.mock
async def test_window_totals_and_order():
    mock_aapl()
    activity = await edgar.get_insider_activity("320193", today=TODAY)

    assert activity.filings_scanned == 4
    assert activity.filings_without_trades == 1
    assert activity.filings_failed == 0
    assert activity.truncated is False
    assert [(t.code, t.transaction_date) for t in activity.transactions] == [
        ("S", "2026-09-29"),
        ("S", "2026-09-15"),
        ("P", "2026-06-23"),
    ]
    assert activity.net_shares == 4770 - 2399 - 1438
    assert activity.net_value == pytest.approx(4770 * 52.38 - 2399 * 336.18 - 1438 * 330.19)
    assert activity.unpriced_count == 0


@respx.mock
async def test_a_warm_call_costs_zero_edgar_requests():
    mock_aapl()
    await edgar.get_insider_activity("320193", today=TODAY)
    cold = len(respx.calls)
    assert cold == 5  # the submissions feed plus one XML per Form 4 in the window

    await edgar.get_insider_activity("320193", today=TODAY)
    assert len(respx.calls) == cold


@respx.mock
async def test_an_unreadable_form4_is_counted_and_not_cached():
    respx.get(SUBMISSIONS_URL).mock(return_value=httpx.Response(200, json=submissions(ROWS[:3])))
    mock_form4("0000000001-26-000001", "aapl_sale")
    mock_form4("0000000001-26-000003", None, status=404)

    activity = await edgar.get_insider_activity("320193", today=TODAY)
    assert activity.filings_scanned == 2
    assert activity.filings_failed == 1
    assert len(activity.transactions) == 1

    before = len(respx.calls)
    await edgar.get_insider_activity("320193", today=TODAY)
    assert len(respx.calls) > before


@respx.mock
async def test_a_hostile_form4_is_counted_as_failed():
    respx.get(SUBMISSIONS_URL).mock(return_value=httpx.Response(200, json=submissions(ROWS[:1])))
    respx.get(f"{ARCHIVES}/000000000126000001/form4.xml").mock(
        return_value=httpx.Response(
            200,
            content=b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "a">]><x>&a;</x>',
        )
    )
    activity = await edgar.get_insider_activity("320193", today=TODAY)
    assert activity.filings_failed == 1
    assert activity.transactions == []


@respx.mock
async def test_a_full_scan_inside_the_window_is_truncated():
    rows = [("4", f"0000000001-26-{i:06d}", "2026-09-30") for i in range(1, 25)]
    respx.get(SUBMISSIONS_URL).mock(return_value=httpx.Response(200, json=submissions(rows)))
    respx.get(url__startswith=ARCHIVES).mock(
        return_value=httpx.Response(200, content=(FIXTURES / "aapl_sale.xml").read_bytes())
    )
    activity = await edgar.get_insider_activity("320193", today=TODAY)
    assert activity.filings_scanned == edgar.INSIDER_MAX_FILINGS
    assert activity.truncated is True


@respx.mock
async def test_no_form4s_is_an_empty_result():
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions([("10-Q", "0000000001-26-000001", "2026-09-01")]))
    )
    activity = await edgar.get_insider_activity("320193", today=TODAY)
    assert activity.filings_scanned == 0
    assert activity.transactions == []
    assert activity.net_shares == 0


# --- endpoint ---

@respx.mock
def test_endpoint_returns_the_activity():
    mock_aapl()
    resp = client.get("/api/companies/320193/insiders")
    assert resp.status_code == 200
    body = resp.json()
    assert body["cik"] == "0000320193"
    assert body["window_days"] == 90


def test_endpoint_rejects_a_bad_cik():
    assert client.get("/api/companies/abc/insiders").status_code == 422


@respx.mock
def test_endpoint_502s_when_the_feed_fails():
    respx.get(SUBMISSIONS_URL).mock(return_value=httpx.Response(404))
    assert client.get("/api/companies/320193/insiders").status_code == 502
