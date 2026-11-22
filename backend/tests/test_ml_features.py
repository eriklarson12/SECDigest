import math

import pytest

from ml import features
from ml.features import FEATURE_NAMES, build_rows, calibration_table, split_of


def frames(**metrics):
    """metric -> {year: {cik: value}}, with every metric present."""
    base = {name: {} for name in ("net_income", "revenue", "gross_profit",
                                  "operating_income", "operating_cash_flow")}
    base.update(metrics)
    return base


def feature(row, name):
    return row.features[FEATURE_NAMES.index(name)]


# --- pairing ---

def test_a_filer_absent_from_the_following_year_is_dropped():
    rows = build_rows(frames(net_income={2011: {1: 5.0, 2: 5.0}, 2012: {1: -3.0}}))
    assert [(r.cik, r.year) for r in rows] == [(1, 2011)]


def test_the_label_is_a_loss_in_the_following_year():
    rows = build_rows(frames(net_income={2011: {1: 5.0, 2: -5.0}, 2012: {1: -1.0, 2: 0.0}}))
    assert {r.cik: r.label for r in rows} == {1: 1, 2: 0}


def test_cy2010_is_only_a_prior_year():
    rows = build_rows(frames(net_income={2010: {1: -1.0}, 2011: {1: 2.0}, 2012: {1: 2.0}}))
    assert [r.year for r in rows] == [2011]
    assert feature(rows[0], "prior_loss") == 1.0
    assert feature(rows[0], "prior_loss_missing") == 0.0


def test_the_last_feature_year_is_2024_labelled_by_2025():
    rows = build_rows(frames(net_income={2024: {1: 1.0}, 2025: {1: -1.0}, 2026: {1: 1.0}}))
    assert [(r.year, r.label) for r in rows] == [(2024, 1)]


def test_rows_are_ordered_by_year_then_cik():
    ni = {2011: {9: 1.0, 3: 1.0}, 2012: {9: 1.0, 3: 1.0}, 2013: {3: 1.0}}
    assert [(r.year, r.cik) for r in build_rows(frames(net_income=ni))] == [
        (2011, 3), (2011, 9), (2012, 3)
    ]


# --- split ---

@pytest.mark.parametrize(
    ("year", "split"),
    [(2010, None), (2011, "train"), (2020, "train"), (2021, "validation"),
     (2022, "validation"), (2023, "test"), (2024, "test"), (2025, None)],
)
def test_the_split_is_by_feature_year(year, split):
    assert split_of(year) == split


# --- features ---

def test_margins_growth_and_log_revenue():
    row, = build_rows(frames(
        net_income={2011: {1: -20.0}, 2012: {1: 1.0}},
        revenue={2010: {1: 80.0}, 2011: {1: 100.0}},
        gross_profit={2011: {1: 40.0}},
        operating_income={2011: {1: -10.0}},
        operating_cash_flow={2011: {1: 5.0}},
    ))
    assert feature(row, "net_margin") == pytest.approx(-0.2)
    assert feature(row, "gross_margin") == pytest.approx(0.4)
    assert feature(row, "operating_margin") == pytest.approx(-0.1)
    assert feature(row, "operating_cash_flow_margin") == pytest.approx(0.05)
    assert feature(row, "revenue_growth") == pytest.approx(0.25)
    assert feature(row, "log_revenue") == pytest.approx(2.0)
    assert feature(row, "loss") == 1.0
    assert all(feature(row, name) == 0.0 for name in FEATURE_NAMES if name.endswith("_missing")
               and name != "prior_loss_missing")
    assert feature(row, "prior_loss_missing") == 1.0


def test_missing_inputs_are_nan_with_their_flag_set():
    row, = build_rows(frames(net_income={2011: {1: 5.0}, 2012: {1: 5.0}}))
    for name in ("net_margin", "gross_margin", "operating_margin",
                 "operating_cash_flow_margin", "revenue_growth", "log_revenue", "prior_loss"):
        assert math.isnan(feature(row, name)), name
    for name in FEATURE_NAMES:
        if name.endswith("_missing"):
            assert feature(row, name) == 1.0, name


@pytest.mark.parametrize("revenue", [0.0, -50.0])
def test_non_positive_revenue_counts_as_missing(revenue):
    row, = build_rows(frames(
        net_income={2011: {1: 5.0}, 2012: {1: 5.0}}, revenue={2011: {1: revenue}}
    ))
    assert math.isnan(feature(row, "net_margin"))
    assert feature(row, "revenue_missing") == 1.0


def test_extreme_ratios_are_clipped():
    row, = build_rows(frames(
        net_income={2011: {1: -50_000_000.0}, 2012: {1: 1.0}},
        revenue={2010: {1: 1.0}, 2011: {1: 1_000.0}},
    ))
    assert feature(row, "net_margin") == -10.0
    assert feature(row, "revenue_growth") == 10.0


def test_scoring_needs_no_following_year():
    scored = features.scoring_rows(
        frames(net_income={2024: {7: -1.0}, 2025: {9: 2.0, 7: -4.0}}, revenue={2025: {7: 8.0}}),
        2025,
    )
    assert [cik for cik, _ in scored] == [7, 9]
    vector = scored[0][1]
    assert vector[FEATURE_NAMES.index("net_margin")] == pytest.approx(-0.5)
    assert vector[FEATURE_NAMES.index("prior_loss")] == 1.0


def test_scoring_skips_filers_without_net_income():
    assert features.scoring_rows(frames(revenue={2025: {1: 5.0}}), 2025) == []


def test_persistence_predicts_the_current_year_loss():
    rows = build_rows(frames(net_income={2011: {1: -1.0, 2: 1.0}, 2012: {1: 1.0, 2: 1.0}}))
    assert features.persistence(rows) == [1.0, 0.0]


# --- scoring ---

def test_brier_score():
    assert features.brier([1, 0], [1.0, 0.0]) == 0.0
    assert features.brier([1, 0], [0.5, 0.5]) == 0.25


def test_calibration_bins_are_fixed_width_and_skip_empty_deciles():
    table = calibration_table([0, 1, 1, 0, 1], [0.05, 0.08, 0.95, 1.0, 0.55])
    assert [(b.decile, b.count) for b in table] == [(0, 2), (5, 1), (9, 2)]
    top = table[-1]
    assert top.mean_predicted == pytest.approx(0.975)
    assert top.observed_rate == 0.5


def test_persistence_calibrates_into_two_bins():
    table = calibration_table([1, 0, 0, 1], [1.0, 1.0, 0.0, 0.0])
    assert [b.decile for b in table] == [0, 9]
