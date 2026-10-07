"""Revenue by reportable segment and by geography, read from a filing's inline XBRL (roadmap 12.8).
Pure, no I/O. The companyfacts and frames APIs carry no dimensional facts, so the primary
document the analysis pipeline already downloads is the only free source.

Every rule here was measured in roadmap 12.7 on AAPL, MSFT, JPM, WKHS and PAVM. A split is
returned only when it adds up to the filing's own total: numbers that do not reconcile never
reach the page."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import date
from itertools import combinations

from collections.abc import Callable

from bs4 import BeautifulSoup, Tag
from bs4.filter import SoupStrainer

from app.models.schemas import RevenueSplit, SegmentRevenue, SegmentRow

logger = logging.getLogger(__name__)

SEGMENT_AXIS = "us-gaap:StatementBusinessSegmentsAxis"
GEOGRAPHY_AXIS = "srt:StatementGeographicalAxis"
CONSOLIDATION_AXIS = "srt:ConsolidationItemsAxis"
OPERATING_SEGMENTS = "us-gaap:OperatingSegmentsMember"

# xbrl._REVENUE_CONCEPTS order, plus the bank total: JPM tags its segments on
# RevenuesNetOfInterestExpense and its geography on Revenues.
REVENUE_CONCEPTS = [
    f"us-gaap:{name}"
    for name in (
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "Revenues",
        "SalesRevenueNet",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
        "RevenuesNetOfInterestExpense",
    )
]

TOLERANCE = 0.01
# A member equal to the sum of others is a subtotal (JPM's TotalInternationalMember). Facts are
# printed in millions, so a true subtotal matches to the unit; this only absorbs rounding.
_SUBTOTAL_TOLERANCE = 0.001
# Subset sums are exponential; a geography with more members than this keeps them all.
_SUBTOTAL_MAX_MEMBERS = 16
_QUARTER_DAYS = range(80, 101)
_ANNUAL_FORMS = {"10-K", "10-K/A"}

_PERIOD_END_RE = re.compile(r"<ix:nonNumeric\b[^>]*\bname=\"dei:DocumentPeriodEndDate\"[^>]*>", re.I)
_CONTEXT_REF_RE = re.compile(r"\bcontextRef=\"([^\"]+)\"", re.I)

# Standard taxonomy members, whose QNames read badly split.
_MEMBER_LABELS = {
    "us-gaap:CorporateNonSegmentMember": "Corporate",
    "us-gaap:MaterialReconcilingItemsMember": "Reconciling items",
    "us-gaap:SegmentReconcilingItemsMember": "Reconciling items",
    "us-gaap:IntersegmentEliminationMember": "Intersegment eliminations",
    "us-gaap:AllOtherSegmentsMember": "All other",
    "srt:NonUsMember": "Outside the US",
    "us-gaap:NonUsMember": "Outside the US",
}
_COUNTRIES = {
    "AU": "Australia", "BR": "Brazil", "CA": "Canada", "CH": "Switzerland", "CN": "China",
    "DE": "Germany", "ES": "Spain", "FR": "France", "GB": "United Kingdom", "HK": "Hong Kong",
    "IE": "Ireland", "IL": "Israel", "IN": "India", "IT": "Italy", "JP": "Japan",
    "KR": "South Korea", "MX": "Mexico", "NL": "Netherlands", "SE": "Sweden", "SG": "Singapore",
    "TW": "Taiwan", "US": "United States",
}
_CAMEL_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
_SMALL_WORDS = {"Of": "of", "And": "and", "The": "the", "For": "for"}


@dataclass(frozen=True)
class _Context:
    start: str | None
    end: str | None
    dims: frozenset[tuple[str, str]]


def member_label(member: str) -> str:
    if member in _MEMBER_LABELS:
        return _MEMBER_LABELS[member]
    prefix, _, local = member.partition(":")
    if prefix == "country":
        return _COUNTRIES.get(local, local)
    local = re.sub(r"(Segment)?Member$", "", local)
    # Filers run words together: JPM's AssetandWealthManagementSegmentMember.
    local = re.sub(r"(?<=[a-z]{3})and(?=[A-Z])", "And", local)
    words = _CAMEL_RE.sub(" ", local).split()
    return " ".join(
        _SMALL_WORDS.get(word, word) if i else word for i, word in enumerate(words)
    )


def _number(text: str, fmt: str, scale: str | None, sign: str | None) -> float | None:
    raw = text.strip()
    if "zero" in fmt or raw in {"-", "—", "–"}:
        return 0.0
    if "comma" in fmt and "decimal" in fmt:
        raw = raw.replace(".", "").replace(" ", "").replace(",", ".")
    elif "num" in fmt or not fmt:
        raw = raw.replace(",", "").replace(" ", "")
    else:
        return None  # word formats ("one"), never revenue
    raw = re.sub(r"[^\d.]", "", raw)
    if not raw or raw.count(".") > 1:
        return None
    value = float(raw) * 10 ** int(scale or 0)
    return -value if sign == "-" else value


def _precision(decimals: str | None) -> float:
    if decimals is None:
        return float("-inf")
    if decimals.upper() == "INF":
        return float("inf")
    try:
        return float(decimals)
    except ValueError:
        return float("-inf")


def _days(start: str, end: str) -> int:
    return (date.fromisoformat(end) - date.fromisoformat(start)).days


def _period(html: str, contexts: dict[str, _Context], form_type: str) -> tuple[str, str] | None:
    """The document's own period for a 10-K. A 10-Q's dei context is year to date (measured on
    AAPL, MSFT and JPM), so the quarter is the shortest 80-100-day context ending the same day."""
    tag = _PERIOD_END_RE.search(html)
    ref = _CONTEXT_REF_RE.search(tag.group(0)) if tag else None
    ctx = contexts.get(ref.group(1)) if ref else None
    if ctx is None or ctx.start is None or ctx.end is None:
        return None
    end = ctx.end
    if form_type in _ANNUAL_FORMS:
        return ctx.start, end
    starts = {
        c.start for c in contexts.values()
        if c.end == end and c.start and _days(c.start, end) in _QUARTER_DAYS
    }
    if not starts:
        return None
    return max(starts), end


def _attr(el: Tag, name: str) -> str | None:
    value = el.get(name)
    return value if isinstance(value, str) else None


def _parse(html: str) -> tuple[dict[str, _Context], list[tuple[str, str, float, float]]]:
    soup = BeautifulSoup(
        html, "html.parser", parse_only=SoupStrainer(["xbrli:context", "ix:nonfraction"])
    )
    contexts: dict[str, _Context] = {}
    for el in soup.find_all("xbrli:context"):
        start = el.find("xbrli:startdate")
        end = el.find("xbrli:enddate")
        dims = frozenset(
            (_attr(m, "dimension") or "", m.get_text(strip=True))
            for m in el.find_all("xbrldi:explicitmember")
        )
        contexts[_attr(el, "id") or ""] = _Context(
            start.get_text(strip=True) if start else None,
            end.get_text(strip=True) if end else None,
            dims,
        )
    facts = []
    for el in soup.find_all("ix:nonfraction"):
        name = _attr(el, "name")
        if name not in REVENUE_CONCEPTS:
            continue
        value = _number(
            el.get_text(), _attr(el, "format") or "", _attr(el, "scale"), _attr(el, "sign")
        )
        if value is not None:
            facts.append(
                (name, _attr(el, "contextref") or "", value, _precision(_attr(el, "decimals")))
            )
    return contexts, facts


def _reconciles(rows: list[SegmentRow], reconciling: list[SegmentRow], total: float) -> bool:
    if total == 0:
        return False
    return abs(sum(r.value for r in rows + reconciling) - total) <= TOLERANCE * abs(total)


def _drop_subtotals(rows: list[SegmentRow]) -> list[SegmentRow]:
    if len(rows) > _SUBTOTAL_MAX_MEMBERS:
        return rows
    kept = list(rows)
    for row in sorted(rows, key=lambda r: -abs(r.value)):
        others = [r for r in kept if r is not row]
        if any(
            abs(sum(r.value for r in combo) - row.value) <= _SUBTOTAL_TOLERANCE * abs(row.value)
            for size in range(2, len(others) + 1)
            for combo in combinations(others, size)
        ):
            kept.remove(row)
    return kept


def _row(member: str, value: float) -> SegmentRow:
    return SegmentRow(member=member, label=member_label(member), value=value)


def _segment_split(
    concept: str, facts: dict[frozenset[tuple[str, str]], float], total: float
) -> RevenueSplit | None:
    rows: dict[str, float] = {}
    reconciling: dict[str, float] = {}
    for dims, value in facts.items():
        axes = dict(dims)
        if set(axes) == {SEGMENT_AXIS} or (
            set(axes) == {SEGMENT_AXIS, CONSOLIDATION_AXIS}
            and axes[CONSOLIDATION_AXIS] == OPERATING_SEGMENTS
        ):
            rows.setdefault(axes[SEGMENT_AXIS], value)
        elif set(axes) == {CONSOLIDATION_AXIS} and axes[CONSOLIDATION_AXIS] != OPERATING_SEGMENTS:
            reconciling[axes[CONSOLIDATION_AXIS]] = value
    if len(rows) < 2:
        return None
    seg_rows = [_row(m, v) for m, v in rows.items()]
    recon_rows = [_row(m, v) for m, v in reconciling.items()]
    for candidate in (recon_rows, []):
        if _reconciles(seg_rows, candidate, total):
            return RevenueSplit(
                concept=concept, total=total, rows=_ranked(seg_rows), reconciling=candidate
            )
    return None


def _geography_split(
    concept: str, facts: dict[frozenset[tuple[str, str]], float], total: float
) -> RevenueSplit | None:
    rows = [
        _row(dict(dims)[GEOGRAPHY_AXIS], value)
        for dims, value in facts.items()
        if {axis for axis, _ in dims} == {GEOGRAPHY_AXIS}
    ]
    if len(rows) < 2:
        return None
    if not _reconciles(rows, [], total):
        rows = _drop_subtotals(rows)
    if len(rows) < 2 or not _reconciles(rows, [], total):
        return None
    return RevenueSplit(concept=concept, total=total, rows=_ranked(rows))


def _ranked(rows: list[SegmentRow]) -> list[SegmentRow]:
    return sorted(rows, key=lambda r: -r.value)


_Facts = dict[frozenset[tuple[str, str]], float]


def _split(
    by_concept: dict[str, _Facts],
    totals: dict[str, float],
    build: Callable[[str, _Facts, float], RevenueSplit | None],
    axis: str,
    label: str,
) -> RevenueSplit | None:
    tagged = False
    for concept in REVENUE_CONCEPTS:
        facts = by_concept.get(concept, {})
        if not any(axis in {a for a, _ in dims} for dims in facts):
            continue
        tagged = True
        if concept in totals:
            split = build(concept, facts, totals[concept])
            if split is not None:
                return split
    if tagged:
        logger.warning("%s: %s revenue tagged but does not reconcile, omitted", label, axis)
    return None


def parse_segments(html: str, form_type: str, label: str = "") -> SegmentRevenue:
    """`label` names the filing in log lines only."""
    contexts, raw_facts = _parse(html)
    period = _period(html, contexts, form_type)
    if period is None:
        return SegmentRevenue()

    # One value per (concept, dimensions): a filer can tag the same figure twice at different
    # scales (WKHS: 21,211 in thousands and 21.2 in millions), and the finer one wins.
    best: dict[tuple[str, frozenset[tuple[str, str]]], tuple[float, float]] = {}
    for concept, ref, value, precision in raw_facts:
        ctx = contexts.get(ref)
        if ctx is None or (ctx.start, ctx.end) != period:
            continue
        key = (concept, ctx.dims)
        if key not in best or precision > best[key][1]:
            best[key] = (value, precision)

    totals: dict[str, float] = {}
    by_concept: dict[str, dict[frozenset[tuple[str, str]], float]] = {}
    for (concept, dims), (value, _) in best.items():
        if dims:
            by_concept.setdefault(concept, {})[dims] = value
        else:
            totals[concept] = value

    return SegmentRevenue(
        period_start=period[0],
        period_end=period[1],
        segments=_split(by_concept, totals, _segment_split, SEGMENT_AXIS, label),
        geography=_split(by_concept, totals, _geography_split, GEOGRAPHY_AXIS, label),
    )
