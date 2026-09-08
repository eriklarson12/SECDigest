"""Exact multi-year financials from SEC's XBRL companyconcept API.
Unlike LLM extraction (one period per filing), returns every tagged fiscal year — free, structured, no extraction error. Powers the trend chart."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Sequence
from typing import NamedTuple, TypeVar

import httpx

from app.config import settings
from app.models.schemas import AnnualFinancials, QuarterlyFinancials, Revision
from app.services.edgar import _get_with_retry

logger = logging.getLogger(__name__)

_CONCEPT_URL = (
    "https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/us-gaap/{concept}.json"
)

# Revenue candidates are alternatives, never merged: companies tag it under different us-gaap concepts
# depending on era/industry, and the one reaching the latest period wins (see _select_series).
_REVENUE_CONCEPTS = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
]
# ProfitLoss is a fallback, not an equal: it includes noncontrolling interests where NetIncomeLoss
# excludes them. A partnership-structured filer tags only the former — QSR (RBI Inc. over RBI LP)
# has filed no NetIncomeLoss on a 10-K or 10-Q since 2015, so without this its quarterly series
# stops at 2020 and its annual series survives only on a proxy pay-versus-performance table.
# Ordered so ProfitLoss wins only when NetIncomeLoss is genuinely behind: the two come out of the
# same filing, so for a filer tagging both they tie on (latest period, breadth) and _select_series
# falls to this order. Verified against AAPL, MSFT, GE, JPM, CMCSA, F and BRK.B: none switch.
_NET_INCOME_CONCEPTS = ["NetIncomeLoss", "ProfitLoss"]
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

# A disclosure, not a feed: five rows is what a reader will check against the source.
_MAX_REVISIONS = 5


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
    Restatements re-file the same period; latest `filed` wins. `unit` selects the units key (per-share concepts use "USD/shares")."""
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
    Instant facts carry `end` with no `start`, so duration filters drop them; a balance is tagged twice (own 10-K + next year's comparative), and latest-`filed` collapses them. Never filter by form type."""
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
    Same latest-`filed` restatement rule as annual; Q4 is often tagged only inside the annual figure, so gaps are expected — never synthesized."""
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


def _revisions(
    concept_data: dict,
    concept: str,
    metric: str,
    years: set[int],
    min_delta_pct: float,
) -> list[Revision]:
    """Periods this concept reports more than once, at materially different values.
    `_annual_values` keeps the latest `filed` and drops the rest; those dropped facts are the only free
    record of a company revising itself. Same duration filter, so balance-sheet instants can't reach here.
    Restricted to `years` — the rows the caller is returning — so every revision names a visible year."""
    grouped: dict[tuple[str, str], dict[str, dict]] = {}
    for entry in concept_data.get("units", {}).get("USD", []):
        start = entry.get("start")
        end = entry.get("end")
        val = entry.get("val")
        accn = entry.get("accn")
        # No accession is no link, and an unverifiable revision is not worth reporting.
        if not start or not end or val is None or not accn:
            continue
        try:
            duration_days = _days_between(start, end)
        except ValueError:
            continue
        if not (_MIN_ANNUAL_DAYS <= duration_days <= _MAX_ANNUAL_DAYS):
            continue
        if int(end[:4]) not in years:
            continue
        # Keyed by accession: one filing reporting a period twice is one report of it.
        grouped.setdefault((start, end), {})[accn] = entry

    revisions: list[Revision] = []
    for (_, end), reports in grouped.items():
        ordered = sorted(reports.values(), key=lambda e: (e.get("filed", ""), e["accn"]))
        if len(ordered) < 2:
            continue
        first_val = float(ordered[0]["val"])
        latest_val = float(ordered[-1]["val"])
        # A percentage off zero is undefined, not infinite.
        if first_val == 0:
            continue
        delta_pct = (latest_val - first_val) / abs(first_val) * 100
        if abs(delta_pct) < min_delta_pct:
            continue
        revisions.append(
            Revision(
                fiscal_year=int(end[:4]),
                metric=metric,
                concept=concept,
                first_val=first_val,
                latest_val=latest_val,
                delta_pct=delta_pct,
                first_accn=ordered[0]["accn"],
                latest_accn=ordered[-1]["accn"],
            )
        )
    return revisions


def _days_between(start: str, end: str) -> int:
    from datetime import date

    y1, m1, d1 = (int(p) for p in start.split("-"))
    y2, m2, d2 = (int(p) for p in end.split("-"))
    return (date(y2, m2, d2) - date(y1, m1, d1)).days


# Annual/instant series are keyed by year, quarterly by ISO end date; both order
# correctly under `max`, so the selection rule below is shared.
_Period = TypeVar("_Period", int, str)


def _select_series(
    candidates: Sequence[tuple[str, dict[_Period, float]]],
) -> tuple[str, dict[_Period, float]] | None:
    """The candidate reaching the latest period wins — NOT the first with any data (filers switch concepts mid-history, e.g. PFE's revenue; found by evals/).
    Ranked by (latest period, breadth), ties falling to candidate order. Never merges candidates by period — that splices two different measures into one line."""
    best: tuple[str, dict[_Period, float]] | None = None
    for concept, values in candidates:
        if not values:
            continue
        if best is None or (max(values), len(values)) > (max(best[1]), len(best[1])):
            best = (concept, values)
    return best


async def _select(
    cik: str,
    concepts: list[str],
    parse: Callable[[dict], dict[_Period, float]],
) -> tuple[str, dict[_Period, float], dict] | None:
    """Fetch every candidate, then keep the one reaching the latest period — with its raw document.
    All fetched concurrently rather than stopping at the first hit — freshest isn't knowable without looking; extra requests are absorbed by the router's TTLCache.
    The document travels with the values so revisions can be read off the *selected* concept without a second fetch, and never off a merge of candidates."""
    documents = await asyncio.gather(
        *(_fetch_concept(cik, concept) for concept in concepts)
    )
    by_concept = {
        concept: document
        for concept, document in zip(concepts, documents)
        if document is not None
    }
    selected = _select_series(
        [(concept, parse(document)) for concept, document in by_concept.items()]
    )
    if selected is None:
        return None
    concept, values = selected
    logger.debug("CIK %s: %s selected (%d periods)", cik, concept, len(values))
    return concept, values, by_concept[concept]


async def _series(
    cik: str,
    concepts: list[str],
    parse: Callable[[dict], dict[_Period, float]],
) -> dict[_Period, float]:
    """The selected candidate's values, for the callers that need no document."""
    selected = await _select(cik, concepts, parse)
    return {} if selected is None else selected[1]


class _Selection(NamedTuple):
    """The winning year-keyed candidate: its values, and the document they were parsed from.
    One type for the annual and instant paths so `get_annual_financials` can gather them together."""

    concept: str
    values: dict[int, float]
    document: dict


# No candidate had data — an empty document yields no values and no revisions.
_NO_SELECTION = _Selection("", {}, {})


async def _select_annual(cik: str, concepts: list[str], unit: str = "USD") -> _Selection:
    """Annual selection keeping the document, for the series that also report revisions."""
    selected = await _select(cik, concepts, lambda data: _annual_values(data, unit=unit))
    return _NO_SELECTION if selected is None else _Selection(*selected)


async def _select_instant(
    cik: str, concepts: list[str], unit: str = "USD"
) -> _Selection:
    """Instant (balance-sheet) selection. Its document reaches no revision: those facts carry no
    duration, so `_revisions`' annual filter drops every one of them."""
    selected = await _select(cik, concepts, lambda data: _instant_values(data, unit=unit))
    return _NO_SELECTION if selected is None else _Selection(*selected)


async def _annual_series(
    cik: str, concepts: list[str], unit: str = "USD"
) -> dict[int, float]:
    """Annual series from whichever candidate reaches the latest year."""
    return (await _select_annual(cik, concepts, unit)).values


async def _instant_series(
    cik: str, concepts: list[str], unit: str = "USD"
) -> dict[int, float]:
    """Instant (balance-sheet) series from the candidate reaching the latest year."""
    return (await _select_instant(cik, concepts, unit)).values


async def _quarterly_series(cik: str, concepts: list[str]) -> dict[str, float]:
    """Quarterly series from the candidate reaching the latest period end."""
    return await _series(cik, concepts, _quarterly_values)


class AnnualFinancialsResult(NamedTuple):
    """The annual rows and the revisions read out of the same payloads."""

    years: list[AnnualFinancials]
    revisions: list[Revision]


async def get_annual_financials(
    cik: str, max_years: int = 8, min_delta_pct: float | None = None
) -> AnnualFinancialsResult:
    """Annual income-statement, cash-flow and balance-sheet series, oldest first, plus revisions.
    Revisions cost no request of their own: they are a second reading of the documents the series above already fetched."""
    (
        revenue,
        net_income,
        eps_diluted,
        operating_cash_flow,
        cash,
        total_assets,
        stockholders_equity,
    ) = await asyncio.gather(
        _select_annual(cik, _REVENUE_CONCEPTS),
        _select_annual(cik, _NET_INCOME_CONCEPTS),
        _select_annual(cik, _EPS_CONCEPTS, unit="USD/shares"),
        _select_annual(cik, _OCF_CONCEPTS),
        _select_instant(cik, _CASH_CONCEPTS),
        _select_instant(cik, _TOTAL_ASSETS_CONCEPTS),
        _select_instant(cik, _STOCKHOLDERS_EQUITY_CONCEPTS),
    )
    # Rows are framed by the income statement — unioning in balance-sheet years would add rows whose
    # only populated cells are balances, which is supplementary data, not a row source.
    years = sorted(set(revenue.values) | set(net_income.values))[-max_years:]
    rows = [
        AnnualFinancials(
            fiscal_year=year,
            revenue=revenue.values.get(year),
            net_income=net_income.values.get(year),
            eps_diluted=eps_diluted.values.get(year),
            operating_cash_flow=operating_cash_flow.values.get(year),
            cash=cash.values.get(year),
            total_assets=total_assets.values.get(year),
            stockholders_equity=stockholders_equity.values.get(year),
        )
        for year in years
    ]

    # EPS is excluded on purpose: it is reported to the cent, so $0.40 -> $0.41 is 2.5% and would
    # cross any threshold that keeps GE. Balance-sheet concepts are instants and cannot reach
    # _revisions at all. Windowed to the rows above, so every revision names a year the reader can see.
    threshold = (
        settings.revision_min_delta_pct if min_delta_pct is None else min_delta_pct
    )
    window = set(years)
    revisions = [
        revision
        for selected, metric in (
            (revenue, "revenue"),
            (net_income, "net_income"),
            (operating_cash_flow, "operating_cash_flow"),
        )
        for revision in _revisions(
            selected.document, selected.concept, metric, window, threshold
        )
    ]
    # Newest first; a year revising two metrics leads with the larger move.
    revisions.sort(key=lambda r: (-r.fiscal_year, -abs(r.delta_pct)))
    return AnnualFinancialsResult(years=rows, revisions=revisions[:_MAX_REVISIONS])


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
