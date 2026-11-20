"""`/evals` reads `loss_model` from the committed history file; `ml.train` writes both it and the
results file. CI cannot run `ml.train` (no scikit-learn there), so this is its staleness check."""

from evals import history_export
from ml import report


def test_the_loss_model_history_matches_the_committed_results():
    runs = report.load_runs()
    assert runs, "ml/results/ has no committed run"
    assert history_export.is_current("loss_model", runs)


def test_every_run_scores_all_three_models_in_order():
    for run in report.load_runs():
        assert [m.name for m in run.models] == ["persistence", "logistic_regression", "xgboost"]

