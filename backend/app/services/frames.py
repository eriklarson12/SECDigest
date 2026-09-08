"""Population percentiles from SEC's XBRL frames API (roadmap 9.4).

One request returns every filer that tagged a concept for a period — 5,638 of them for
NetIncomeLoss/USD/CY2025, in 840 KiB. That is what turns `/benchmark` from relative ("better than
the peers you picked") into absolute ("better than 99% of filers"). Frames are shared by every user
and every company, so the cache is global and the marginal cost of a second company is zero."""

from __future__ import annotations

import asyncio
import bisect
import logging
from collections.abc import Callable, Coroutine
from datetime import datetime, timezone
from typing import NamedTuple

import httpx

from app.cache import frames_cache
from app.models.schemas import Percentile
from app.services.edgar import _get_with_retry
from app.services.xbrl import _OCF_CONCEPTS, _REVENUE_CONCEPTS

logger = logging.getLogger(__name__)

_FRAMES_URL = "https://data.sec.gov/api/xbrl/frames/us-gaap/{concept}/USD/{period}.json"

# Net income keeps its own list rather than importing xbrl.py's, which carries a ProfitLoss
# fallback. The two modules merge differently: xbrl.py picks one concept per company, frames unions
# candidates across a population. Unioning here would let a filer be ranked on income including
# noncontrolling interests while the metrics table directly above the bar shows income excluding
# them — the same figure-disagrees-with-the-row-above-it failure that keeps instant concepts out.
_NET_INCOME_CONCEPTS = ["NetIncomeLoss"]

# Metric -> its concept candidates. Only annual duration concepts: an *instant* frame does not line
# up with a filer's fiscal year, and pretending it does is worse than omitting the metric.
# Assets/USD/CY2025Q4I carries Apple at 2025-12-27, its Q1 FY2026 balance sheet, not the FY2025
# year end of 2025-09-27 the metrics table shows.
_METRIC_CONCEPTS: tuple[tuple[str, list[str]], ...] = (
    ("revenue", _REVENUE_CONCEPTS),
    ("net_income", _NET_INCOME_CONCEPTS),
    ("operating_cash_flow", _OCF_CONCEPTS),
)

# The current calendar year's annual frame is empty until filers report: measured 2026-09-08,
# CY2026 held 86 filers against CY2025's 5,638 and CY2024's 6,053. A frame under this floor is not
# a population, so the resolver steps back a year rather than ranking against a handful.
_MIN_FRAME_POINTS = 1_000
# Two steps reaches CY-2 from January, which is as stale as a ranking may usefully get.
_MAX_LOOKBACK_YEARS = 2

_PERIOD_KEY = "period:annual"


class Frame(NamedTuple):
    """One metric's population for one period, in the shapes a percentile needs.

    `values` is sorted for the bisect; `by_cik` answers whether a filer is in the population at all
    and at what figure. The parsed frame body is never kept: it is 3,286 KB of Python objects for
    NetIncomeLoss CY2025 against 752 KB for these (measured), on a 512 MB dyno.

    `concepts` is per filer rather than per frame because revenue is a union of four candidates and
    a caption has to name the one that actually supplied the figure. `ends` is per filer because
    frames bucket by approximate calendar alignment, so a period end is not derivable from
    `period`: AAR CORP's year ends 2026-05-31 and sits in CY2025."""

    period: str
    values: list[float]
    by_cik: dict[int, float]
    ends: dict[int, str]
    concepts: dict[int, str]


# Cached in place of a frame that does not exist, so a 404 is paid for once a day rather than once
# per request. It never reaches a percentile: `_usable` rejects it for having no values.
_EMPTY_FRAME = Frame("", [], {}, {}, {})

# Keyed by cache key, so ten concurrent /benchmark rows on a cold cache share one fetch per frame
# instead of issuing sixty. Coordinates within one process only — the same caveat as
# services/indexing.py's pacer, and the reason Dockerfile pins --workers 1.
_inflight: dict[str, asyncio.Task] = {}


def percentile_of(values: list[float], value: float) -> float:
    """Midrank percentile: everything strictly below, plus half of the ties.

    Ties are not hypothetical — 93 of the 5,638 NetIncomeLoss CY2025 values are duplicates — and
    both obvious definitions misreport them, crediting a tied block with the whole run or with none
    of it. Midrank centres it."""
    below = bisect.bisect_left(values, value)
    above = bisect.bisect_right(values, value)
    return 100 * (below + (above - below) / 2) / len(values)


def _usable(frame: Frame | None) -> Frame | None:
    return frame if frame is not None and frame.values else None


async def _once(key: str, build: Callable[[], Coroutine[None, None, Frame]]) -> Frame:
    """Run `build` once per key across concurrent callers.

    Shielded because awaiting a task propagates the awaiter's cancellation into it: one client
    disconnecting mid-request must not cancel the frame nine other rows are waiting on."""
    task = _inflight.get(key)
    if task is None:
        task = asyncio.create_task(build())
        _inflight[key] = task
        task.add_done_callback(lambda _: _inflight.pop(key, None))
    return await asyncio.shield(task)


async def _fetch_frame(concept: str, period: str) -> Frame:
    """One concept-period frame, or `_EMPTY_FRAME` when no filer tagged it.

    A 404 is an absence, not a failure: `SalesRevenueNet` is deprecated and has no CY2025 frame at
    all, yet it is still a legitimate member of `_REVENUE_CONCEPTS`."""
    url = _FRAMES_URL.format(concept=concept, period=period)
    try:
        resp = await _get_with_retry(url, timeout=30)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            frames_cache.set(f"{concept}:{period}", _EMPTY_FRAME)
            return _EMPTY_FRAME
        raise

    by_cik: dict[int, float] = {}
    ends: dict[int, str] = {}
    for point in resp.json().get("data", []):
        cik, val, end = point.get("cik"), point.get("val"), point.get("end")
        if cik is None or val is None or not end:
            continue
        by_cik[int(cik)] = float(val)
        ends[int(cik)] = end

    frame = Frame(
        period=period,
        values=sorted(by_cik.values()),
        by_cik=by_cik,
        ends=ends,
        concepts=dict.fromkeys(by_cik, concept),
    )
    frames_cache.set(f"{concept}:{period}", frame)
    logger.debug("Frame %s/%s: %d filers", concept, period, len(by_cik))
    return frame


async def _concept_frame(concept: str, period: str) -> Frame:
    cached = frames_cache.get(f"{concept}:{period}")
    if cached is not None:
        return cached
    return await _once(f"{concept}:{period}", lambda: _fetch_frame(concept, period))


async def _build_metric_frame(concepts: list[str], period: str) -> Frame:
    """Merge a metric's concept candidates into one population, first candidate winning per filer.

    The alternatives-never-merged rule `xbrl.py` applies to one company, applied to a population:
    a filer's figure comes from exactly one concept and is **never summed** across them. Measured
    for CY2025, revenue's union reaches 4,665 filers where its largest single concept reaches
    2,692, so a single-concept percentile would rank against less than half the filers that
    actually reported revenue."""
    frames = await asyncio.gather(
        *(_concept_frame(concept, period) for concept in concepts)
    )

    by_cik: dict[int, float] = {}
    ends: dict[int, str] = {}
    concept_by_cik: dict[int, str] = {}
    for frame in frames:
        for cik, value in frame.by_cik.items():
            if cik in by_cik:
                continue
            by_cik[cik] = value
            ends[cik] = frame.ends[cik]
            concept_by_cik[cik] = frame.concepts[cik]

    return Frame(
        period=period,
        values=sorted(by_cik.values()),
        by_cik=by_cik,
        ends=ends,
        concepts=concept_by_cik,
    )


async def _metric_frame(metric: str, concepts: list[str], period: str) -> Frame:
    """The merged population for one metric, cached so the merge is not redone per request."""
    if len(concepts) == 1:
        return await _concept_frame(concepts[0], period)

    key = f"metric:{metric}:{period}"
    cached = frames_cache.get(key)
    if cached is not None:
        return cached
    frame = await _once(key, lambda: _build_metric_frame(concepts, period))
    frames_cache.set(key, frame)
    return frame


def _utc_year() -> int:
    """A seam, so period resolution is testable without depending on the wall clock."""
    return datetime.now(timezone.utc).year


async def _resolve_period() -> str | None:
    """The one calendar frame period everything is ranked against, or None when none is populated.

    One period for the whole app, deliberately: a benchmark column pitting one company's CY2025
    rank against another's CY2024 is not a comparison. The probe is the NetIncomeLoss fetch the
    ranking needs anyway, so a resolved period costs no request of its own."""
    cached = frames_cache.get(_PERIOD_KEY)
    if cached is not None:
        return cached or None

    latest = _utc_year() - 1
    for year in range(latest, latest - _MAX_LOOKBACK_YEARS - 1, -1):
        period = f"CY{year}"
        frame = _usable(await _concept_frame(_NET_INCOME_CONCEPTS[0], period))
        if frame is not None and len(frame.values) >= _MIN_FRAME_POINTS:
            frames_cache.set(_PERIOD_KEY, period)
            return period

    # "" rather than None: a TTLCache miss already reads as None, so a negative result needs a
    # value of its own or every request would re-probe three frames.
    frames_cache.set(_PERIOD_KEY, "")
    return None


def _measure(metric: str, frame: Frame, cik: int) -> Percentile | None:
    """This filer's standing in one population, or None when it is not in it.

    Absent is absent: a filer that never tagged the concept has no percentile, and reporting it as
    a 0th would say it came last among filers it was never among."""
    value = frame.by_cik.get(cik)
    if value is None or not frame.values:
        return None
    return Percentile(
        metric=metric,
        concept=frame.concepts[cik],
        period=frame.period,
        period_end=frame.ends[cik],
        value=value,
        percentile=percentile_of(frame.values, value),
        population=len(frame.values),
    )


async def get_percentiles(cik: str) -> list[Percentile]:
    """Where this filer's revenue, net income and operating cash flow sit among every filer.

    Degrades to `[]` on any failure, never raising: this decorates the metrics table, and the table
    has to render whether or not EDGAR answered. Swallowed here rather than at the caller so no
    caller can forget it."""
    try:
        period = await _resolve_period()
        if period is None:
            return []
        frames = await asyncio.gather(
            *(
                _metric_frame(metric, concepts, period)
                for metric, concepts in _METRIC_CONCEPTS
            )
        )
    except Exception:
        logger.warning("Frames lookup failed for CIK %s", cik, exc_info=True)
        return []

    subject = int(cik)
    measured = [
        _measure(metric, frame, subject)
        for (metric, _), frame in zip(_METRIC_CONCEPTS, frames)
    ]
    return [p for p in measured if p is not None]
