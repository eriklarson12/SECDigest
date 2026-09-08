import asyncio
import json
from pathlib import Path

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app.main import app
from app.services import frames


client = TestClient(app, raise_server_exceptions=False)

FRAMES = "https://data.sec.gov/api/xbrl/frames/us-gaap"

# The trimmed frames carry 8-12 filers, far under the real _MIN_FRAME_POINTS floor of 1,000.
# Tests that are not about period resolution lower it; the two that are keep the real value.
SMALL = 1


def load_fixture(name):
    """A trimmed capture of a real frames payload; `_source` records the URL."""
    return json.loads((Path(__file__).parent / "fixtures" / name).read_text())


FIXTURES = {
    "NetIncomeLoss": "frames_netincomeloss_cy2025.json",
    "Revenues": "frames_revenues_cy2025.json",
    "RevenueFromContractWithCustomerExcludingAssessedTax": "frames_revenue_excl_cy2025.json",
    "RevenueFromContractWithCustomerIncludingAssessedTax": "frames_revenue_incl_cy2025.json",
    "NetCashProvidedByUsedInOperatingActivities": "frames_ocf_cy2025.json",
}

AAPL = 320193
GE = 40545
# Tagged under two revenue concepts at different values: 19,464M under the declared-first
# candidate and 19,976M under Revenues. Neither the loser nor their sum may appear.
TWO_CONCEPT_CIK = 3570
# Its fiscal year ends 2026-05-31 and EDGAR files it under CY2025 — the calendar-alignment
# caution, captured rather than described.
AAR = 1750


@pytest.fixture(autouse=True)
def small_population(monkeypatch):
    monkeypatch.setattr(frames, "_MIN_FRAME_POINTS", SMALL)
    yield


def mock_cy2025(**overrides):
    """Serve the captured CY2025 frames; every other frame URL 404s, as EDGAR does for a
    concept-period no filer tagged. Specific routes first — respx matches in registration order."""
    for concept, name in FIXTURES.items():
        body = overrides.get(concept, load_fixture(name))
        respx.get(f"{FRAMES}/{concept}/USD/CY2025.json").mock(
            return_value=httpx.Response(200, json=body)
        )
    respx.get(url__regex=rf"{FRAMES}/.*").mock(return_value=httpx.Response(404))


# --- percentile_of ---

def test_percentile_is_midrank_over_the_population():
    values = [1.0, 2.0, 3.0, 4.0]
    assert frames.percentile_of(values, 1.0) == 12.5
    assert frames.percentile_of(values, 4.0) == 87.5


def test_ties_split_the_block_rather_than_taking_all_of_it():
    # Three filers tied at 2.0 all rank at the block's centre. Counting strictly-below would
    # credit them 12.5; counting at-or-below would credit them 87.5. Both misreport a tie.
    values = [1.0, 2.0, 2.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    assert frames.percentile_of(values, 2.0) == 31.25


def test_values_outside_the_population_reach_the_ends():
    values = [10.0, 20.0, 30.0]
    assert frames.percentile_of(values, 5.0) == 0.0
    assert frames.percentile_of(values, 99.0) == 100.0


def test_a_single_filer_population_is_the_midpoint():
    assert frames.percentile_of([7.0], 7.0) == 50.0


# --- the revenue union ---

@respx.mock
async def test_revenue_unions_every_candidate_concept():
    mock_cy2025()
    frame = await frames._metric_frame("revenue", frames._REVENUE_CONCEPTS, "CY2025")

    # 8 from the first candidate, 3 more from Revenues, 1 more from the including-tax concept.
    assert len(frame.values) == 12
    assert len(frame.by_cik) == 12
    # Larger than any member: the whole point of the union.
    assert len(frame.by_cik) > len(load_fixture(FIXTURES["Revenues"])["data"])


@respx.mock
async def test_a_filer_in_two_concepts_takes_the_declared_first_and_is_never_summed():
    mock_cy2025()
    frame = await frames._metric_frame("revenue", frames._REVENUE_CONCEPTS, "CY2025")

    assert frame.by_cik[TWO_CONCEPT_CIK] == 19_464_000_000
    assert frame.concepts[TWO_CONCEPT_CIK] == (
        "RevenueFromContractWithCustomerExcludingAssessedTax"
    )
    # The sum would be 39,440M. Merging two measures into one figure is the failure this guards.
    assert frame.by_cik[TWO_CONCEPT_CIK] != 19_464_000_000 + 19_976_000_000


@respx.mock
async def test_a_404_concept_contributes_nothing_and_does_not_raise():
    # SalesRevenueNet is deprecated and has no CY2025 frame at all, yet it is still a member
    # of _REVENUE_CONCEPTS. Its absence must cost the union nothing.
    mock_cy2025()
    frame = await frames._metric_frame("revenue", frames._REVENUE_CONCEPTS, "CY2025")
    assert "SalesRevenueNet" not in frame.concepts.values()
    assert len(frame.values) == 12


@respx.mock
async def test_net_income_is_not_unioned_with_the_tables_profit_loss_fallback():
    # xbrl.py falls back to ProfitLoss for a filer that abandoned NetIncomeLoss; frames
    # deliberately does not follow it. A union here would rank a filer on income *including*
    # noncontrolling interests while the metrics table directly above the bar shows income
    # excluding them, and the bar would disagree with the row it annotates.
    mock_cy2025()
    await frames.get_percentiles(str(AAPL))

    assert frames._NET_INCOME_CONCEPTS == ["NetIncomeLoss"]
    assert not any("ProfitLoss" in str(call.request.url) for call in respx.calls)


# --- get_percentiles ---

@respx.mock
async def test_percentiles_rank_the_filer_in_all_three_populations():
    mock_cy2025()
    results = {p.metric: p for p in await frames.get_percentiles(str(AAPL))}

    assert set(results) == {"revenue", "net_income", "operating_cash_flow"}
    assert results["revenue"].value == 416_161_000_000
    assert results["revenue"].population == 12
    assert results["revenue"].percentile == pytest.approx(95.8333, abs=1e-3)
    assert results["net_income"].percentile == pytest.approx(95.4545, abs=1e-3)
    assert results["operating_cash_flow"].percentile == pytest.approx(87.5)


@respx.mock
async def test_the_named_concept_is_the_one_that_supplied_the_figure():
    mock_cy2025()
    revenue = {p.metric: p for p in await frames.get_percentiles(str(GE))}["revenue"]
    # GE tags revenue under Revenues, not under the union's first candidate. A caption naming
    # the wrong concept would send a reader to a tag GE never used.
    assert revenue.concept == "Revenues"


@respx.mock
async def test_period_end_carries_the_filers_own_year_not_the_calendar_one():
    mock_cy2025()
    aar = {p.metric: p for p in await frames.get_percentiles(str(AAR))}["revenue"]
    # Frames bucket by approximate calendar alignment. This year ends well outside CY2025,
    # which is exactly the fact the caption has to admit.
    assert aar.period == "CY2025"
    assert aar.period_end == "2026-05-31"


@respx.mock
async def test_a_filer_absent_from_a_population_gets_no_percentile_for_it():
    mock_cy2025()
    # Apple is in the net income and OCF frames but not in the Revenues frame; it reaches the
    # revenue union through another candidate. A filer in none of them gets nothing at all.
    results = await frames.get_percentiles("9999999")
    assert results == []


@respx.mock
async def test_a_frames_outage_degrades_to_no_percentile():
    respx.get(url__regex=rf"{FRAMES}/.*").mock(return_value=httpx.Response(500))
    assert await frames.get_percentiles(str(AAPL)) == []


# --- period resolution (real _MIN_FRAME_POINTS) ---

@respx.mock
async def test_an_underpopulated_frame_is_skipped_for_the_year_before_it(monkeypatch):
    monkeypatch.setattr(frames, "_MIN_FRAME_POINTS", 5)
    monkeypatch.setattr(frames, "_utc_year", lambda: 2027)
    # The current year's frame really does look like this: CY2026 held 86 filers on 2026-09-08.
    thin = {"data": [{"cik": 1, "val": 1, "end": "2026-12-31"}]}
    respx.get(f"{FRAMES}/NetIncomeLoss/USD/CY2026.json").mock(
        return_value=httpx.Response(200, json=thin)
    )
    respx.get(f"{FRAMES}/NetIncomeLoss/USD/CY2025.json").mock(
        return_value=httpx.Response(200, json=load_fixture(FIXTURES["NetIncomeLoss"]))
    )
    assert await frames._resolve_period() == "CY2025"


@respx.mock
async def test_no_populated_frame_within_the_lookback_yields_no_ranking(monkeypatch):
    monkeypatch.setattr(frames, "_MIN_FRAME_POINTS", 1_000)
    respx.get(url__regex=rf"{FRAMES}/.*").mock(return_value=httpx.Response(404))
    assert await frames._resolve_period() is None
    assert await frames.get_percentiles(str(AAPL)) == []


# --- request cost ---

@respx.mock
async def test_a_warm_cache_costs_zero_edgar_requests():
    mock_cy2025()
    await frames.get_percentiles(str(AAPL))
    cold = len(respx.calls)
    assert cold == 7  # 4 revenue candidates (one 404s), net income, 2 OCF candidates

    await frames.get_percentiles(str(GE))
    assert len(respx.calls) == cold


@respx.mock
async def test_concurrent_cold_callers_share_one_fetch_per_frame():
    mock_cy2025()
    # Ten /benchmark rows landing together must not multiply the cost by ten.
    await asyncio.gather(*(frames.get_percentiles(str(AAPL)) for _ in range(10)))
    assert len(respx.calls) == 7


# --- endpoint ---

@respx.mock
def test_financials_body_carries_percentiles():
    mock_cy2025()
    respx.get(url__regex=r"https://data\.sec\.gov/api/xbrl/companyconcept/.*").mock(
        return_value=httpx.Response(404)
    )
    body = client.get(f"/api/financials/{AAPL}").json()
    assert {p["metric"] for p in body["percentiles"]} == {
        "revenue",
        "net_income",
        "operating_cash_flow",
    }


@respx.mock
def test_a_frames_failure_still_returns_the_table():
    respx.get(url__regex=rf"{FRAMES}/.*").mock(return_value=httpx.Response(500))
    respx.get(url__regex=r"https://data\.sec\.gov/api/xbrl/companyconcept/.*").mock(
        return_value=httpx.Response(404)
    )
    resp = client.get(f"/api/financials/{AAPL}")
    assert resp.status_code == 200
    assert resp.json()["percentiles"] == []
