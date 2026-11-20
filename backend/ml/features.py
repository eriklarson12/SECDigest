"""Year pairing, the time split and feature arithmetic for the net-loss base rate (roadmap 17.1).

Pure Python, no third-party imports, so it runs under the normal pytest the way `evals/scoring.py`
does. `ml/train.py` turns these rows into arrays; nothing here knows a model exists."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Literal, NamedTuple

# metric -> year -> cik -> value, as `ml/dataset.fetch_metric` returns per year.
Frames = Mapping[str, Mapping[int, Mapping[int, float]]]

Split = Literal["train", "validation", "test"]

# CY2010 is fetched but only as 2011's prior year, so no row's prior inputs are missing merely
# because the window starts. The last feature year is the last one with a following year.
FIRST_FEATURE_YEAR = 2011
LAST_FEATURE_YEAR = 2024

TRAIN_THROUGH = 2020
VALIDATION_YEARS = (2021, 2022)
TEST_YEARS = (2023, 2024)

# A filer with $1k of revenue and a $50M loss has a margin of -50,000, which would set the
# scaler's spread for every other row. Clipping keeps the sign and the "very large" without that.
_MARGIN_BOUND = 10.0
_GROWTH_BOUNDS = (-1.0, 10.0)

FEATURE_NAMES: tuple[str, ...] = (
    "net_margin",
    "gross_margin",
    "operating_margin",
    "operating_cash_flow_margin",
    "revenue_growth",
    "log_revenue",
    "loss",
    "prior_loss",
    "revenue_missing",
    "gross_profit_missing",
    "operating_income_missing",
    "operating_cash_flow_missing",
    "prior_revenue_missing",
    "prior_loss_missing",
)

# A feature whose input is missing is NaN for train.py's imputer; the `_missing` flags keep the fact.
NAN = float("nan")


class Row(NamedTuple):
    cik: int
    year: int
    features: tuple[float, ...]
    label: int


def split_of(year: int) -> Split | None:
    if FIRST_FEATURE_YEAR <= year <= TRAIN_THROUGH:
        return "train"
    if year in VALIDATION_YEARS:
        return "validation"
    if year in TEST_YEARS:
        return "test"
    return None


def _clip(value: float, low: float, high: float) -> float:
    return min(max(value, low), high)


def _margin(numerator: float | None, revenue: float | None) -> float:
    if numerator is None or revenue is None:
        return NAN
    return _clip(numerator / revenue, -_MARGIN_BOUND, _MARGIN_BOUND)


def _positive(value: float | None) -> float | None:
    """Revenue as a denominator: zero or negative is as unusable as absent."""
    return value if value is not None and value > 0 else None


def _flag(value: float | None) -> float:
    return 1.0 if value is None else 0.0


def features_for(frames: Frames, cik: int, year: int) -> tuple[float, ...]:
    """The FEATURE_NAMES vector for one filer-year. The caller has checked net income exists."""

    def get(metric: str, y: int) -> float | None:
        return frames[metric].get(y, {}).get(cik)

    net = get("net_income", year)
    assert net is not None
    revenue = _positive(get("revenue", year))
    prior_revenue = _positive(get("revenue", year - 1))
    gross = get("gross_profit", year)
    operating = get("operating_income", year)
    cash_flow = get("operating_cash_flow", year)
    prior_net = get("net_income", year - 1)

    growth = (
        _clip(revenue / prior_revenue - 1, *_GROWTH_BOUNDS)
        if revenue is not None and prior_revenue is not None
        else NAN
    )
    return (
        _margin(net, revenue),
        _margin(gross, revenue),
        _margin(operating, revenue),
        _margin(cash_flow, revenue),
        growth,
        math.log10(revenue) if revenue is not None else NAN,
        1.0 if net < 0 else 0.0,
        NAN if prior_net is None else (1.0 if prior_net < 0 else 0.0),
        _flag(revenue),
        _flag(gross),
        _flag(operating),
        _flag(cash_flow),
        _flag(prior_revenue),
        _flag(prior_net),
    )


def build_rows(frames: Frames) -> list[Row]:
    """One row per filer with net income in both *t* and *t+1*, sorted by (year, cik).

    A filer absent from *t+1* has no label and is dropped. Requiring *t* as well keeps the
    persistence baseline defined on every row, so all three models score the same population."""
    net_income = frames["net_income"]
    rows: list[Row] = []
    for year in range(FIRST_FEATURE_YEAR, LAST_FEATURE_YEAR + 1):
        now, following = net_income.get(year, {}), net_income.get(year + 1, {})
        for cik in sorted(now.keys() & following.keys()):
            label = 1 if following[cik] < 0 else 0
            rows.append(Row(cik, year, features_for(frames, cik, year), label))
    return rows


def persistence(rows: Sequence[Row]) -> list[float]:
    """Loss in *t* predicts loss in *t+1*, as a 0/1 probability."""
    loss = FEATURE_NAMES.index("loss")
    return [row.features[loss] for row in rows]


def brier(labels: Sequence[int], probabilities: Sequence[float]) -> float:
    return sum((p - y) ** 2 for y, p in zip(labels, probabilities, strict=True)) / len(labels)


class CalibrationBin(NamedTuple):
    decile: int
    count: int
    mean_predicted: float
    observed_rate: float


def calibration_table(
    labels: Sequence[int], probabilities: Sequence[float]
) -> list[CalibrationBin]:
    """Rows by predicted-probability decile: decile *d* holds 0.1·d ≤ p < 0.1·(d+1), and p = 1
    falls in the top one. Fixed-width rather than quantile bins, so a model that only ever says
    0 or 1 (persistence) shows two bins instead of ten that cut ties arbitrarily. Empty deciles
    are left out."""
    bins: dict[int, list[tuple[int, float]]] = {}
    for y, p in zip(labels, probabilities, strict=True):
        bins.setdefault(min(int(p * 10), 9), []).append((y, p))
    return [
        CalibrationBin(
            decile=d,
            count=len(members),
            mean_predicted=sum(p for _, p in members) / len(members),
            observed_rate=sum(y for y, _ in members) / len(members),
        )
        for d, members in sorted(bins.items())
    ]
