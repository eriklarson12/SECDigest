"""`evals/history_export.py` owns the JSON the static `/evals` page reads. Two `score` commands write one file, so each must leave the other's half alone."""

import json

from evals import history_export
from evals.qa_scoring import QASummary
from evals.scoring import RunSummary


def _qa(run_date: str) -> QASummary:
    return QASummary(
        run_date=run_date,
        model="gemini-3.5-flash-lite",
        retrieval_k=6,
        questions=20,
        grounded_rate=1.0,
        refusal_rate=1.0,
        hit_rate_at_k=0.867,
        citation_precision=0.411,
        citation_precision_v2=None,
    )


def _extraction(run_date: str) -> RunSummary:
    return RunSummary(
        run_date=run_date,
        model="gemini-3.6-flash",
        max_filing_chars=600_000,
        filings=10,
        accuracy=1.0,
        scored=40,
        correct=40,
    )


def test_a_write_keeps_the_other_suites_runs(tmp_path):
    path = tmp_path / "data" / "eval-history.json"
    history_export.write("extraction", [_extraction("2026-08-14")], path)
    history_export.write("qa", [_qa("2026-09-14")], path)

    data = json.loads(path.read_text())
    assert [r["run_date"] for r in data["extraction"]] == ["2026-08-14"]
    assert [r["run_date"] for r in data["qa"]] == ["2026-09-14"]


def test_runs_are_sorted_oldest_first(tmp_path):
    path = tmp_path / "eval-history.json"
    history_export.write("qa", [_qa("2026-10-08"), _qa("2026-09-14")], path)
    assert [r["run_date"] for r in json.loads(path.read_text())["qa"]] == ["2026-09-14", "2026-10-08"]


def test_a_null_metric_is_kept_as_null():
    """The page draws a gap for a metric a run predates; dropping the key would read as a schema change."""
    data = json.loads(history_export.render({}, "qa", [_qa("2026-09-14")]))
    assert data["qa"][0]["citation_precision_v2"] is None


def test_staleness_is_judged_per_suite(tmp_path):
    path = tmp_path / "eval-history.json"
    history_export.write("qa", [_qa("2026-09-14")], path)

    assert history_export.is_current("qa", [_qa("2026-09-14")], path)
    assert not history_export.is_current("qa", [_qa("2026-09-14"), _qa("2026-10-08")], path)
    assert not history_export.is_current("extraction", [_extraction("2026-08-14")], path)


def test_an_unreadable_file_is_rewritten_rather_than_raising(tmp_path):
    path = tmp_path / "eval-history.json"
    path.write_text("not json")
    history_export.write("qa", [_qa("2026-09-14")], path)
    assert list(json.loads(path.read_text())) == ["qa"]
