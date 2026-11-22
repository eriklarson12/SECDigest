"""Train and score the net-loss base rate (roadmap 17.1).

Needs ml/.venv (see ml/requirements.txt). Fetches any frame missing from ml/.cache through
edgar's paced client, fits logistic regression on the train years and XGBoost with early stopping
on the validation years, and scores all three models on the test years.

Run from backend/:  ml/.venv/bin/python -m ml.train
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from xgboost import XGBClassifier

from app.services import edgar
from evals import history_export
from ml import dataset, features, report

_SEED = 0
_DIGITS = 4


async def _load_frames() -> dict[str, dict[int, dict[int, float]]]:
    try:
        return {
            metric: {
                year: await dataset.fetch_metric(metric, year)
                for year in range(dataset.FIRST_YEAR, dataset.LAST_YEAR + 1)
            }
            for metric in dataset.METRICS
        }
    finally:
        await edgar.close_client()


def _frame(rows: list[features.Row]) -> tuple[pd.DataFrame, np.ndarray]:
    x = pd.DataFrame([row.features for row in rows], columns=list(features.FEATURE_NAMES))
    y = np.array([row.label for row in rows])
    return x, y


def _score(name: report.ModelName, labels: np.ndarray, probs: list[float]) -> report.ModelScore:
    y = [int(v) for v in labels]
    return report.ModelScore(
        name=name,
        pr_auc=round(float(average_precision_score(y, probs)), _DIGITS),
        brier=round(features.brier(y, probs), _DIGITS),
        calibration=[
            report.CalibrationRow(
                decile=b.decile,
                count=b.count,
                mean_predicted=round(b.mean_predicted, _DIGITS),
                observed_rate=round(b.observed_rate, _DIGITS),
            )
            for b in features.calibration_table(y, probs)
        ],
    )


def fit(run_date: str) -> tuple[report.LossModelRun, XGBClassifier, features.Frames]:
    """The scored run, the fitted XGBoost model and the frames it was built from.
    `ml.score` reuses all three, so the model it scores with is the one the run describes."""
    frames = asyncio.run(_load_frames())
    rows = features.build_rows(frames)
    split = {
        name: [r for r in rows if features.split_of(r.year) == name]
        for name in ("train", "validation", "test")
    }
    x_train, y_train = _frame(split["train"])
    x_val, y_val = _frame(split["validation"])
    x_test, y_test = _frame(split["test"])

    logistic = Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        ("model", LogisticRegression(max_iter=1_000)),
    ]).fit(x_train, y_train)

    # XGBoost takes NaN as "missing" natively, so it sees no imputed values. One thread keeps the
    # tree build, and so the results file, bit-identical between runs.
    boosted = XGBClassifier(
        n_estimators=2_000,
        learning_rate=0.05,
        max_depth=4,
        early_stopping_rounds=50,
        eval_metric="logloss",
        tree_method="hist",
        random_state=_SEED,
        n_jobs=1,
    ).fit(x_train, y_train, eval_set=[(x_val, y_val)], verbose=False)

    result = report.LossModelRun(
        run_date=run_date,
        train_years=[features.FIRST_FEATURE_YEAR, features.TRAIN_THROUGH],
        validation_years=[features.VALIDATION_YEARS[0], features.VALIDATION_YEARS[-1]],
        test_years=[features.TEST_YEARS[0], features.TEST_YEARS[-1]],
        rows=report.SplitRows(**{name: len(r) for name, r in split.items()}),
        test_loss_rate=round(float(y_test.mean()), _DIGITS),
        xgboost_best_iteration=int(boosted.best_iteration),
        models=[
            _score("persistence", y_test, features.persistence(split["test"])),
            _score("logistic_regression", y_test,
                   [float(p) for p in logistic.predict_proba(x_test)[:, 1]]),
            _score("xgboost", y_test, [float(p) for p in boosted.predict_proba(x_test)[:, 1]]),
        ],
    )
    return result, boosted, frames


def run(run_date: str) -> report.LossModelRun:
    return fit(run_date)[0]


def _print(result: report.LossModelRun) -> None:
    print(f"rows {result.rows.model_dump()}  test loss rate {result.test_loss_rate:.3f}")
    print(f"{'model':<22}{'PR-AUC':>8}{'Brier':>8}")
    for m in result.models:
        print(f"{m.name:<22}{m.pr_auc:>8.4f}{m.brier:>8.4f}")
    for m in result.models:
        print(f"\n{m.name} calibration\n{'decile':<8}{'n':>7}{'predicted':>11}{'observed':>10}")
        for b in m.calibration:
            print(f"{b.decile:<8}{b.count:>7,}{b.mean_predicted:>11.3f}{b.observed_rate:>10.3f}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m ml.train")
    parser.add_argument("--date", default=dt.datetime.now(dt.UTC).date().isoformat())
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    result = run(args.date)
    out = args.out or report.RESULTS_DIR / f"{args.date}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(result.model_dump_json(indent=2) + "\n")
    if out.parent.resolve() == report.RESULTS_DIR.resolve():
        history_export.write("loss_model", report.load_runs())
    _print(result)
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
