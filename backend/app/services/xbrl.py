"""Exact multi-year financials from SEC's XBRL companyconcept API.

Unlike the LLM extraction (one period per analyzed filing), this returns the
as-reported annual figures for every fiscal year the company has tagged —
free, structured, and with no extraction error. Powers the trend chart.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

from app.models.schemas import AnnualFinancials, QuarterlyFinancials
from app.services.edgar import _get_with_retry

logger = logging.getLogger(__name__)

_CONCEPT_URL = (
    "https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/us-gaap/{concept}.json"
)

# Companies tag revenue under different us-gaap concepts depending on era and
# industry; first candidate with annual USD data wins.
_REVENUE_CONCEPTS = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
]
_NET_INCOME_CONCEPTS = ["NetIncomeLoss"]
# Per-share concepts live under the "USD/shares" unit key, not "USD".
_EPS_CONCEPTS = ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"]
_OCF_CONCEPTS = [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
]
# Balance-sheet concepts are *instant* facts (`end` only, no `start`).
_CASH_CONCEPTS = [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
]
_TOTAL_ASSETS_CONCEPTS = ["Assets"]
_STOCKHOLDERS_EQUITY_CONCEPTS = [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
]

# A duration of roughly one year distinguishes annual entries from the
# quarterly/nine-month periods that share the same concept.
_MIN_ANNUAL_DAYS = 340
_MAX_ANNUAL_DAYS = 400
# Roughly one quarter; six-/nine-month YTD entries fall outside this window.
_MIN_QUARTER_DAYS = 80
_MAX_QUARTER_DAYS = 100


async def _fetch_concept(cik: str, concept: str) -> dict | None:
    """Fetch one companyconcept document; None when the company never tagged it."""
    url = _CONCEPT_URL.format(cik=cik.zfill(10), concept=concept)
    try:
        resp = await _get_with_retry(url, timeout=30)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            return None
        raise
    return resp.json()


def _annual_values(concept_data: dict, unit: str = "USD") -> dict[int, float]:
    """Map fiscal year (labelled by period end year) → as-reported value.

    Restatements re-file the same period; the entry with the latest `filed`
    date wins. `unit` selects the units key (per-share concepts use
    "USD/shares", not "USD").
    """
    entries = concept_data.get("units", {}).get(unit, [])
    best: dict[int, tuple[str, float]] = {}
    for entry in entries:
        start = entry.get("start")
        end = entry.get("end")
        val = entry.get("val")
        filed = entry.get("filed", "")
        if not start or not end or val is None:
            continue
        try:
            duration_days = _days_between(start, end)
        except ValueError:
            continue
        if not (_MIN_ANNUAL_DAYS <= duration_days <= _MAX_ANNUAL_DAYS):
            continue
        year = int(end[:4])
        if year not in best or filed > best[year][0]:
            best[year] = (filed, float(val))
    return {year: value for year, (_, value) in best.items()}


def _instant_values(concept_data: dict, unit: str = "USD") -> dict[int, float]:
    """Map fiscal year (labelled by measurement year) → as-reported balance.

    Balance-sheet facts are measured at a point in time, so entries carry an
    `end` and no `start` — the duration filters above would drop every one.

    A fiscal-year-end balance is tagged twice: once in that year's 10-K and
    again as the comparative column of the *next* year's 10-K. Both share the
    same `end`, so the latest-`filed` rule (also the restatement rule) collapses
    them to one value. Never filter these by form type.
    """
    entries = concept_data.get("units", {}).get(unit, [])
    best: dict[int, tuple[str, float]] = {}
    for entry in entries:
        end = entry.get("end")
        val = entry.get("val")
        filed = entry.get("filed", "")
        if entry.get("start") is not None or not end or val is None:
            continue
        try:
            # The duration parsers reach _days_between first, which rejects
            # malformed dates; instant entries need their own guard.
            year = int(end[:4])
        except ValueError:
            continue
        if year not in best or filed > best[year][0]:
            best[year] = (filed, float(val))
    return {year: value for year, (_, value) in best.items()}


def _quarterly_values(concept_data: dict) -> dict[str, float]:
    """Map period end date (ISO string) → as-reported USD value for quarters.

    Same latest-`filed` restatement rule as annual. Many filers tag Q4 only
    inside the annual figure, so Q4 gaps are expected — never synthesized.
    """
    entries = concept_data.get("units", {}).get("USD", [])
    best: dict[str, tuple[str, float]] = {}
    for entry in entries:
        start = entry.get("start")
        end = entry.get("end")
        val = entry.get("val")
        filed = entry.get("filed", "")
        if not start or not end or val is None:
            continue
        try:
            duration_days = _days_between(start, end)
        except ValueError:
            continue
        if not (_MIN_QUARTER_DAYS <= duration_days <= _MAX_QUARTER_DAYS):
            continue
        if end not in best or filed > best[end][0]:
            best[end] = (filed, float(val))
    return {end: value for end, (_, value) in best.items()}


def _days_between(start: str, end: str) -> int:
    from datetime import date

    y1, m1, d1 = (int(p) for p in start.split("-"))
    y2, m2, d2 = (int(p) for p in end.split("-"))
    return (date(y2, m2, d2) - date(y1, m1, d1)).days


async def _annual_series(
    cik: str, concepts: list[str], unit: str = "USD"
) -> dict[int, float]:
    """First concept candidate that yields annual data wins."""
    for concept in concepts:
        data = await _fetch_concept(cik, concept)
        if data is None:
            continue
        values = _annual_values(data, unit=unit)
        if values:
            return values
    return {}


async def _instant_series(
    cik: str, concepts: list[str], unit: str = "USD"
) -> dict[int, float]:
    """First concept candidate that yields instant (balance-sheet) data wins."""
    for concept in concepts:
        data = await _fetch_concept(cik, concept)
        if data is None:
            continue
        values = _instant_values(data, unit=unit)
        if values:
            return values
    return {}


async def _quarterly_series(cik: str, concepts: list[str]) -> dict[str, float]:
    """First concept candidate that yields quarterly data wins."""
    for concept in concepts:
        data = await _fetch_concept(cik, concept)
        if data is None:
            continue
        values = _quarterly_values(data)
        if values:
            return values
    return {}


async def get_annual_financials(cik: str, max_years: int = 8) -> list[AnnualFinancials]:
    """Annual income-statement, cash-flow and balance-sheet series, oldest first."""
    (
        revenue,
        net_income,
        eps_diluted,
        operating_cash_flow,
        cash,
        total_assets,
        stockholders_equity,
    ) = await asyncio.gather(
        _annual_series(cik, _REVENUE_CONCEPTS),
        _annual_series(cik, _NET_INCOME_CONCEPTS),
        _annual_series(cik, _EPS_CONCEPTS, unit="USD/shares"),
        _annual_series(cik, _OCF_CONCEPTS),
        _instant_series(cik, _CASH_CONCEPTS),
        _instant_series(cik, _TOTAL_ASSETS_CONCEPTS),
        _instant_series(cik, _STOCKHOLDERS_EQUITY_CONCEPTS),
    )
    # Rows are framed by the income statement. Balance-sheet concepts often
    # reach further back, and unioning them in would add rows whose only
    # populated cells are balances — supplementary data, not a row source.
    years = sorted(set(revenue) | set(net_income))
    return [
        AnnualFinancials(
            fiscal_year=year,
            revenue=revenue.get(year),
            net_income=net_income.get(year),
            eps_diluted=eps_diluted.get(year),
            operating_cash_flow=operating_cash_flow.get(year),
            cash=cash.get(year),
            total_assets=total_assets.get(year),
            stockholders_equity=stockholders_equity.get(year),
        )
        for year in years[-max_years:]
    ]


async def get_quarterly_financials(
    cik: str, max_quarters: int = 12
) -> list[QuarterlyFinancials]:
    """Quarterly revenue + net income series, oldest first, capped at max_quarters."""
    revenue, net_income = await asyncio.gather(
        _quarterly_series(cik, _REVENUE_CONCEPTS),
        _quarterly_series(cik, _NET_INCOME_CONCEPTS),
    )
    ends = sorted(set(revenue) | set(net_income))
    return [
        QuarterlyFinancials(
            period_end=end,
            revenue=revenue.get(end),
            net_income=net_income.get(end),
        )
        for end in ends[-max_quarters:]
    ]
