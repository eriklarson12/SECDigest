"""The committed results file for the net-loss base rate (roadmap 17.1) and its loader.

No scikit-learn or XGBoost here: CI reads these files to check `/evals`' data, and CI MUST NOT
import either library."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel

RESULTS_DIR = Path(__file__).parent / "results"

ModelName = Literal["persistence", "logistic_regression", "xgboost"]


class CalibrationRow(BaseModel):
    decile: int
    count: int
    mean_predicted: float
    observed_rate: float


class ModelScore(BaseModel):
    name: ModelName
    pr_auc: float
    brier: float
    calibration: list[CalibrationRow]


class SplitRows(BaseModel):
    train: int
    validation: int
    test: int


class LossModelRun(BaseModel):
    run_date: str
    train_years: list[int]
    validation_years: list[int]
    test_years: list[int]
    rows: SplitRows
    test_loss_rate: float
    xgboost_best_iteration: int
    # Scored on the test years only, in a fixed order so the page reads baseline first.
    models: list[ModelScore]


def load_runs(directory: Path = RESULTS_DIR) -> list[LossModelRun]:
    return [
        LossModelRun.model_validate_json(path.read_text())
        for path in sorted(directory.glob("*.json"))
    ]
