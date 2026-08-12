import httpx
import respx
from fastapi.testclient import TestClient

from app.main import app
from app.services import xbrl


client = TestClient(app, raise_server_exceptions=False)

BASE = "https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap"


def entry(start, end, val, filed="2024-01-01"):
    return {"start": start, "end": end, "val": val, "filed": filed}


def instant_entry(end, val, filed="2024-01-01"):
    """Balance-sheet fact: an `end` and no `start` key at all."""
    return {"end": end, "val": val, "filed": filed}


def concept(entries):
    return {"units": {"USD": entries}}


def mock_all_404():
    respx.get(url__regex=r"https://data\.sec\.gov/api/xbrl/companyconcept/.*").mock(
        return_value=httpx.Response(404)
    )


# --- _annual_values (parsing) ---

def test_annual_entries_kept_quarterly_excluded():
    data = concept(
        [
            entry("2023-01-01", "2023-12-31", 100),
            entry("2023-10-01", "2023-12-31", 25),  # quarterly duration — excluded
            entry("2022-01-01", "2022-12-31", 90),
        ]
    )
    assert xbrl._annual_values(data) == {2023: 100.0, 2022: 90.0}


def test_restatement_latest_filed_wins():
    data = concept(
        [
            entry("2023-01-01", "2023-12-31", 100, filed="2024-02-01"),
            entry("2023-01-01", "2023-12-31", 105, filed="2024-06-01"),  # restated
        ]
    )
    assert xbrl._annual_values(data) == {2023: 105.0}


def test_malformed_entries_skipped():
    data = concept(
        [
            {"end": "2023-12-31", "val": 100},           # no start
            entry("2023-01-01", "2023-12-31", None),      # no value
            {"start": "bad", "end": "2023-12-31", "val": 1},
            entry("2022-01-01", "2022-12-31", 90),
        ]
    )
    assert xbrl._annual_values(data) == {2022: 90.0}


def test_non_calendar_fiscal_year_labelled_by_end_year():
    # Apple-style fiscal year ending late September
    data = concept([entry("2022-09-25", "2023-09-30", 383)])
    assert xbrl._annual_values(data) == {2023: 383.0}


# --- get_annual_financials (concept fallback + merge) ---

@respx.mock
async def test_revenue_concept_fallback_and_merge():
    respx.get(f"{BASE}/RevenueFromContractWithCustomerExcludingAssessedTax.json").mock(
        return_value=httpx.Response(404)
    )
    respx.get(f"{BASE}/Revenues.json").mock(
        return_value=httpx.Response(
            200,
            json=concept(
                [
                    entry("2022-01-01", "2022-12-31", 900),
                    entry("2023-01-01", "2023-12-31", 1000),
                ]
            ),
        )
    )
    respx.get(f"{BASE}/NetIncomeLoss.json").mock(
        return_value=httpx.Response(
            200, json=concept([entry("2023-01-01", "2023-12-31", 200)])
        )
    )
    mock_all_404()  # EPS / operating-cash-flow concepts untagged

    years = await xbrl.get_annual_financials("320193")
    assert [(y.fiscal_year, y.revenue, y.net_income) for y in years] == [
        (2022, 900.0, None),
        (2023, 1000.0, 200.0),
    ]


@respx.mock
async def test_max_years_keeps_most_recent():
    entries = [entry(f"{y}-01-01", f"{y}-12-31", y) for y in range(2010, 2024)]
    respx.get(f"{BASE}/RevenueFromContractWithCustomerExcludingAssessedTax.json").mock(
        return_value=httpx.Response(200, json=concept(entries))
    )
    mock_all_404()

    years = await xbrl.get_annual_financials("320193", max_years=8)
    assert len(years) == 8
    assert years[0].fiscal_year == 2016
    assert years[-1].fiscal_year == 2023


# --- _quarterly_values (parsing) ---

def test_quarterly_duration_filter():
    data = concept(
        [
            entry("2023-07-01", "2023-09-30", 25),   # 91 days — included
            entry("2023-01-01", "2023-09-30", 75),   # ~272-day YTD — excluded
            entry("2023-01-01", "2023-12-31", 100),  # annual — excluded
        ]
    )
    assert xbrl._quarterly_values(data) == {"2023-09-30": 25.0}


def test_quarterly_restatement_latest_filed_wins():
    data = concept(
        [
            entry("2023-07-01", "2023-09-30", 25, filed="2023-11-01"),
            entry("2023-07-01", "2023-09-30", 26, filed="2024-02-01"),  # restated
        ]
    )
    assert xbrl._quarterly_values(data) == {"2023-09-30": 26.0}


@respx.mock
async def test_max_quarters_keeps_most_recent():
    entries = [
        entry(f"{y}-07-01", f"{y}-09-30", y) for y in range(2010, 2026)
    ]
    respx.get(f"{BASE}/RevenueFromContractWithCustomerExcludingAssessedTax.json").mock(
        return_value=httpx.Response(200, json=concept(entries))
    )
    mock_all_404()

    quarters = await xbrl.get_quarterly_financials("320193", max_quarters=12)
    assert len(quarters) == 12
    assert quarters[0].period_end == "2014-09-30"
    assert quarters[-1].period_end == "2025-09-30"


# --- EPS (USD/shares unit) + operating cash flow ---

def _mock_annual_concepts_404_except(**overrides):
    """Mock specific concepts, then 404 everything else (specific routes first —
    respx matches in registration order)."""
    for concept_name, payload in overrides.items():
        respx.get(f"{BASE}/{concept_name}.json").mock(
            return_value=httpx.Response(200, json=payload)
        )
    mock_all_404()


@respx.mock
async def test_eps_parsed_from_usd_shares_unit():
    eps_data = {"units": {"USD/shares": [entry("2022-09-25", "2023-09-30", 6.13)]}}
    _mock_annual_concepts_404_except(
        Revenues=concept([entry("2022-09-25", "2023-09-30", 383_000)]),
        EarningsPerShareDiluted=eps_data,
    )
    years = await xbrl.get_annual_financials("320193")
    assert len(years) == 1
    assert years[0].eps_diluted == 6.13
    assert years[0].operating_cash_flow is None  # missing concept → None, no failure


@respx.mock
async def test_operating_cash_flow_merged():
    _mock_annual_concepts_404_except(
        Revenues=concept([entry("2023-01-01", "2023-12-31", 1000)]),
        NetCashProvidedByUsedInOperatingActivities=concept(
            [entry("2023-01-01", "2023-12-31", 400)]
        ),
    )
    years = await xbrl.get_annual_financials("320193")
    assert years[0].operating_cash_flow == 400.0


# --- _instant_values (balance-sheet parsing) ---

def test_instant_entries_kept_duration_excluded():
    data = concept(
        [
            instant_entry("2023-12-31", 350),
            instant_entry("2022-12-31", 320),
            entry("2023-01-01", "2023-12-31", 100),   # duration — excluded
            entry("2023-07-01", "2023-09-30", 25),    # duration — excluded
        ]
    )
    assert xbrl._instant_values(data) == {2023: 350.0, 2022: 320.0}


def test_instant_comparative_restatement_latest_filed_wins():
    # The FY2023 balance is tagged in the FY2023 10-K and again as the
    # comparative column of the FY2024 10-K — same `end`, later `filed`.
    data = concept(
        [
            instant_entry("2023-12-31", 350, filed="2024-02-01"),
            instant_entry("2023-12-31", 352, filed="2025-02-01"),
        ]
    )
    assert xbrl._instant_values(data) == {2023: 352.0}


def test_instant_malformed_entries_skipped():
    data = concept(
        [
            {"val": 100, "filed": "2024-01-01"},          # no end
            instant_entry("2023-12-31", None),             # no value
            {"end": "bad", "val": 1, "filed": "2024-01-01"},
            instant_entry("2022-12-31", 320),
        ]
    )
    assert xbrl._instant_values(data) == {2022: 320.0}


@respx.mock
async def test_balance_sheet_merged_and_untagged_stay_none():
    _mock_annual_concepts_404_except(
        Revenues=concept([entry("2023-01-01", "2023-12-31", 1000)]),
        Assets=concept([instant_entry("2023-12-31", 352_000)]),
    )
    years = await xbrl.get_annual_financials("320193")
    assert years[0].total_assets == 352_000.0
    # Untagged balance-sheet concepts degrade to None, never an error
    assert years[0].cash is None
    assert years[0].stockholders_equity is None


@respx.mock
async def test_cash_concept_fallback():
    respx.get(f"{BASE}/CashAndCashEquivalentsAtCarryingValue.json").mock(
        return_value=httpx.Response(404)
    )
    _mock_annual_concepts_404_except(
        Revenues=concept([entry("2023-01-01", "2023-12-31", 1000)]),
        CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents=concept(
            [instant_entry("2023-12-31", 30_000)]
        ),
    )
    years = await xbrl.get_annual_financials("320193")
    assert years[0].cash == 30_000.0


@respx.mock
async def test_balance_sheet_only_years_do_not_create_rows():
    # Assets reach back further than revenue; rows stay framed by the
    # income statement rather than sprouting balance-only years.
    _mock_annual_concepts_404_except(
        Revenues=concept([entry("2023-01-01", "2023-12-31", 1000)]),
        Assets=concept(
            [instant_entry("2019-12-31", 300), instant_entry("2023-12-31", 352)]
        ),
    )
    years = await xbrl.get_annual_financials("320193")
    assert [y.fiscal_year for y in years] == [2023]


# --- GET /api/financials/{cik} ---

def test_invalid_cik_is_422():
    resp = client.get("/api/financials/320193x")
    assert resp.status_code == 422
    resp = client.get("/api/financials/12345678901")  # 11 digits — too long
    assert resp.status_code == 422
    # Traversal payloads never reach the handler — path routing 404s them
    resp = client.get("/api/financials/..%2Fetc")
    assert resp.status_code in (404, 422)


@respx.mock
def test_no_tagged_data_is_empty_200():
    mock_all_404()
    resp = client.get("/api/financials/320193")
    assert resp.status_code == 200
    assert resp.json() == {"cik": "320193", "years": [], "quarters": []}


@respx.mock
def test_sec_outage_is_502():
    respx.get(url__regex=r"https://data\.sec\.gov/api/xbrl/companyconcept/.*").mock(
        return_value=httpx.Response(500)
    )
    resp = client.get("/api/financials/320193")
    assert resp.status_code == 502


@respx.mock
def test_endpoint_returns_annual_and_quarterly():
    respx.get(f"{BASE}/RevenueFromContractWithCustomerExcludingAssessedTax.json").mock(
        return_value=httpx.Response(
            200,
            json=concept(
                [
                    entry("2023-01-01", "2023-12-31", 1000),
                    entry("2023-07-01", "2023-09-30", 250),
                ]
            ),
        )
    )
    mock_all_404()
    resp = client.get("/api/financials/320193")
    body = resp.json()
    assert [y["fiscal_year"] for y in body["years"]] == [2023]
    assert body["quarters"] == [
        {"period_end": "2023-09-30", "revenue": 250.0, "net_income": None}
    ]
