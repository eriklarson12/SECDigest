"""The eval harness itself hits real EDGAR and spends real Gemini quota, never run in CI — these cover the pure scoring rules that decide what it reports.
`evals/scoring.py` is deliberately import-clean (no network, no settings), which is what lets these run in the normal pytest suite."""

import json
from pathlib import Path

import pytest

from app.models.schemas import AnalysisRequest
from evals import scoring
from evals.scoring import (
    ExtractionRecord,
    GoldenEntry,
    GroundTruth,
    RunArtifact,
    score_value,
    score_yoy_sign,
)


# --- ±1% tolerance ---

@pytest.mark.parametrize(
    "value,expected",
    [
        (1_000_000.0, "correct"),      # exact
        (1_005_000.0, "correct"),      # +0.5%, inside
        (990_100.0, "correct"),        # -0.99%, just inside
        (1_020_000.0, "wrong"),        # +2%, outside
        (989_000.0, "wrong"),          # -1.1%, just outside
    ],
)
def test_tolerance_boundary(value, expected):
    assert score_value(value, 1_000_000.0).verdict == expected


def test_zero_truth_falls_back_to_absolute_comparison():
    """A relative miss against 0 is infinite — the percentage rule can't apply."""
    assert score_value(0.0, 0.0).verdict == "correct"
    assert score_value(0.5, 0.0).verdict == "correct"
    assert score_value(1_000.0, 0.0).verdict == "wrong"


# --- missing values on either side ---

def test_missing_extraction_with_ground_truth_is_wrong():
    score = score_value(None, 1_000_000.0)
    assert score.verdict == "wrong"
    assert score.detail == "missing"


def test_missing_ground_truth_is_not_the_models_fault():
    assert score_value(1_000_000.0, None).verdict == "no_ground_truth"
    assert score_value(None, None).verdict == "no_ground_truth"


def test_no_ground_truth_is_excluded_from_the_denominator():
    """The rule most easily broken by a later refactor, so assert the arithmetic.
    Two correct fields out of two *scoreable* ones is 100%, not 50% — fields XBRL couldn't answer are reported separately."""
    record = ExtractionRecord(
        ticker="X",
        cik="1",
        accession_number="a",
        fiscal_year=2024,
        revenue_current=100.0,
        revenue_yoy_change_pct=10.0,
        net_income_current=50.0,
        net_income_yoy_change_pct=5.0,
    )
    truth = GroundTruth(
        fiscal_year=2024,
        revenue=100.0,
        revenue_prior=90.0,
        net_income=None,      # no concept covers it
        net_income_prior=None,
    )

    totals = scoring.totals([scoring.score_record(record, truth)])

    assert totals.correct == 2
    assert totals.wrong == 0
    assert totals.no_ground_truth == 2
    assert totals.scored == 2
    assert totals.accuracy == 1.0


def test_accuracy_is_none_when_nothing_was_scoreable():
    assert scoring.Totals(no_ground_truth=4).accuracy is None


# --- failure classification ---

def test_unapplied_thousands_scale_is_named():
    """The most common real failure: the filing says "(in thousands)"."""
    assert score_value(394_328.0, 394_328_000_000.0).detail.startswith("scale")
    assert "1e+06" in score_value(394_328.0, 394_328_000_000.0).detail


def test_scale_classification_covers_both_directions():
    assert score_value(1_000_000.0, 1_000.0).detail == "scale (×1e+03)"
    assert score_value(1_000.0, 1_000_000.0).detail == "scale (÷1e+03)"


def test_sign_flip_beats_scale_when_both_could_match():
    """A loss reported as a profit is a sign error, not a magnitude error."""
    assert score_value(-500.0, 500.0).detail == "sign"


def test_prior_year_figure_is_recognised_as_a_period_error():
    """Reading the comparative column of the income statement."""
    series = {2023: 383_285_000_000.0, 2024: 391_035_000_000.0}
    score = score_value(383_285_000_000.0, 391_035_000_000.0, series)
    assert score.verdict == "wrong"
    assert score.detail == "period (matches FY2023)"


def test_unexplained_miss_is_other():
    assert score_value(123.0, 456.0, {2023: 999.0}).detail == "other"


# --- YoY direction ---

def test_yoy_sign_matches_and_mismatches():
    assert score_yoy_sign(5.5, 110.0, 100.0).verdict == "correct"
    assert score_yoy_sign(-5.5, 90.0, 100.0).verdict == "correct"
    assert score_yoy_sign(5.5, 90.0, 100.0).verdict == "wrong"
    assert score_yoy_sign(5.5, 90.0, 100.0).detail == "sign"


def test_narrowing_loss_counts_as_improvement():
    """-100 → -50 is a positive delta, and the prompt's |prior| denominator
    makes the model's percentage positive too — they must agree."""
    assert score_yoy_sign(50.0, -50.0, -100.0).verdict == "correct"
    assert score_yoy_sign(-50.0, -50.0, -100.0).verdict == "wrong"


def test_yoy_needs_both_years_of_ground_truth():
    assert score_yoy_sign(5.5, 110.0, None).verdict == "no_ground_truth"
    assert score_yoy_sign(5.5, None, 100.0).verdict == "no_ground_truth"


def test_flat_year_is_not_scoreable():
    """Zero delta has no sign to match."""
    assert score_yoy_sign(0.0, 100.0, 100.0).verdict == "no_ground_truth"


def test_missing_yoy_with_ground_truth_present_is_wrong():
    score = score_yoy_sign(None, 110.0, 100.0)
    assert score.verdict == "wrong"
    assert score.detail == "missing"


# --- run errors ---

def test_a_failed_filing_scores_as_error_not_wrong():
    record = ExtractionRecord(
        ticker="X", cik="1", accession_number="a", fiscal_year=2024, error="LLMError: boom"
    )
    totals = scoring.totals([scoring.score_record(record, GroundTruth(fiscal_year=2024))])
    assert totals.errors == 4
    assert totals.scored == 0


# --- rendering ---

def _artifact(records):
    return RunArtifact(
        run_date="2026-08-13",
        model="gemini-3.6-flash",
        max_filing_chars=600_000,
        records=records,
    )


def test_report_renders_a_row_per_filing_with_the_overall_figure():
    records = [
        ExtractionRecord(
            ticker="AAPL",
            cik="320193",
            accession_number="a",
            fiscal_year=2025,
            revenue_current=100.0,
            revenue_yoy_change_pct=10.0,
            net_income_current=50.0,
            net_income_yoy_change_pct=5.0,
        )
    ]
    truth = GroundTruth(
        fiscal_year=2025,
        revenue=100.0,
        revenue_prior=90.0,
        net_income=50.0,
        net_income_prior=48.0,
    )
    artifact = _artifact(records)
    scores = [scoring.score_record(records[0], truth)]
    report = scoring.render_markdown(artifact, scores, [scoring.summarize(artifact, scores)])

    assert "| AAPL | 2025 | ✓ | ✓ | ✓ | ✓ |" in report
    assert "**Overall: 4/4 scored fields correct (100.0%)**" in report
    assert "gemini-3.6-flash" in report
    assert "MAX_FILING_CHARS=600,000" in report


def test_report_explains_each_miss_in_the_notes_column():
    records = [
        ExtractionRecord(
            ticker="X",
            cik="1",
            accession_number="a",
            fiscal_year=2024,
            revenue_current=1_000.0,          # thousands, unapplied
            net_income_current=None,
        )
    ]
    truth = GroundTruth(fiscal_year=2024, revenue=1_000_000.0, net_income=None)
    scores = [scoring.score_record(records[0], truth)]
    report = scoring.render_markdown(_artifact(records), scores, [])

    assert "revenue: scale (÷1e+03)" in report
    assert "net income: no XBRL concept" in report
    assert "had no XBRL ground truth" in report


def test_history_is_sorted_newest_first():
    summaries = [
        scoring.RunSummary(
            run_date=date, model="m", max_filing_chars=1, filings=1,
            accuracy=0.5, scored=2, correct=1,
        )
        for date in ("2026-07-01", "2026-08-13", "2026-06-01")
    ]
    report = scoring.render_markdown(_artifact([]), [], summaries)
    rows = [line for line in report.splitlines() if line.startswith("| 2026-")]
    assert [row.split(" | ")[0] for row in rows] == ["| 2026-08-13", "| 2026-07-01", "| 2026-06-01"]


# --- baseline comparison ---

def test_delta_line_reports_direction_and_both_figures():
    baseline = scoring.RunSummary(
        run_date="2026-08-01", model="gemini-3.6-flash", max_filing_chars=300_000,
        filings=10, accuracy=0.75, scored=40, correct=30,
    )
    records = [
        ExtractionRecord(
            ticker="X", cik="1", accession_number="a", fiscal_year=2024,
            revenue_current=100.0, net_income_current=50.0,
        )
    ]
    truth = GroundTruth(fiscal_year=2024, revenue=100.0, net_income=50.0)
    scores = [scoring.score_record(records[0], truth)]
    report = scoring.render_markdown(_artifact(records), scores, [], baseline)

    assert "+25.0 pts" in report
    assert "75.0% → 100.0%" in report


def test_regressions_name_only_fields_that_got_worse():
    def record(revenue):
        return ExtractionRecord(
            ticker="X", cik="1", accession_number="a", fiscal_year=2024,
            revenue_current=revenue, net_income_current=50.0,
        )

    truth = GroundTruth(fiscal_year=2024, revenue=100.0, net_income=50.0)
    before = [scoring.score_record(record(100.0), truth)]
    after = [scoring.score_record(record(100_000.0), truth)]

    assert scoring.regressions(after, before) == ["X revenue (scale (×1e+03))"]
    assert scoring.regressions(before, after) == []


# --- which failures the run retries ---

def test_dropped_connection_is_recognised_through_the_wrapper():
    """`_generate` wraps a dead socket in a plain LLMError, which is worth
    retrying — one of these cost a filing on the first real run."""
    from evals.eval_extraction import _is_transport_failure
    from app.services.llm import LLMError

    dropped = ConnectionError("Remote end closed connection without response")
    try:
        raise LLMError("Gemini request failed") from dropped
    except LLMError as exc:
        assert _is_transport_failure(exc)


def test_malformed_output_is_not_treated_as_transient():
    """analyze_filing already re-sampled once; a second failure is a real
    extraction result, and retrying it would hide what the eval measures."""
    from evals.eval_extraction import _is_transport_failure
    from app.services.llm import LLMError

    try:
        raise LLMError("LLM returned malformed output after retry") from ValueError("bad json")
    except LLMError as exc:
        assert not _is_transport_failure(exc)


def test_cause_chain_walk_terminates_on_a_self_referencing_cycle():
    from evals.eval_extraction import _is_transport_failure

    a = RuntimeError("a")
    b = RuntimeError("b")
    a.__cause__ = b
    b.__cause__ = a
    assert _is_transport_failure(a) is False


# --- how a run survives a flaky model ---

@pytest.fixture
def stub_run(monkeypatch, tmp_path):
    """Drive `run` with no network and no artifacts written into the repo."""
    from app.services import edgar
    from evals import eval_extraction

    def _install(outcomes):
        entries = [
            GoldenEntry(
                ticker=f"T{i}",
                cik="320193",
                company_name="Co",
                # Distinct per entry: accession number is what --resume keys on.
                accession_number=f"0000320193-25-00007{i}",
                primary_document="d.htm",
                fiscal_year=2025,
            )
            for i in range(len(outcomes))
        ]
        remaining = list(outcomes)
        attempted: list[str] = []

        async def fetch(cik, accession_number, primary_document):
            return "filing text"

        async def analyze(filing_text, form_type, company_name, ticker):
            attempted.append(ticker)
            outcome = remaining[len(set(attempted)) - 1]
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        monkeypatch.setattr(eval_extraction, "load_golden", lambda: entries)
        monkeypatch.setattr(eval_extraction, "analyze_filing", analyze)
        monkeypatch.setattr(eval_extraction, "_RESULTS_DIR", tmp_path)
        monkeypatch.setattr(eval_extraction, "_OVERLOAD_BACKOFF", 0.0)
        monkeypatch.setattr(edgar, "fetch_filing_text", fetch)
        return attempted

    return _install


def _good_analysis():
    from app.models.schemas import FilingAnalysis, FinancialMetric

    return FilingAnalysis(
        revenue=FinancialMetric(current=100.0, yoy_change_pct=5.0),
        net_income=FinancialMetric(current=50.0, yoy_change_pct=2.0),
        risk_factors=["r"],
        management_guidance="g",
        summary="s",
    )


async def test_one_hopeless_filing_does_not_abandon_the_rest(stub_run):
    """Overload tracks request size as well as load — the largest filing can fail
    while every other one succeeds, so it's written off, not fatal."""
    from app.services.llm import LLMOverloadedError
    from evals.eval_extraction import run

    stub_run([LLMOverloadedError("busy"), _good_analysis(), _good_analysis()])
    code, path = await run(ticker=None, limit=None, sleep=0, tag=None, allow_fallback=False)

    assert path is not None
    artifact = RunArtifact.model_validate_json(path.read_text())
    assert [r.ticker for r in artifact.records] == ["T0", "T1", "T2"]
    assert artifact.records[0].error and artifact.records[0].error.startswith("overloaded")
    assert artifact.records[1].error is None
    assert code == 1  # a written-off filing still fails the run


async def test_a_run_of_overloads_stops_the_whole_eval(stub_run):
    """Three in a row is an outage, not a busy minute — don't work through 20 more."""
    from app.services.llm import LLMOverloadedError
    from evals.eval_extraction import _OVERLOAD_GIVE_UP, run

    stub_run([LLMOverloadedError("busy")] * 5)
    _, path = await run(ticker=None, limit=None, sleep=0, tag=None, allow_fallback=False)

    assert path is not None
    artifact = RunArtifact.model_validate_json(path.read_text())
    assert len(artifact.records) == _OVERLOAD_GIVE_UP


async def test_a_spent_daily_pool_stops_immediately(stub_run):
    """Unlike an overload, there is no window to wait out — nothing is written off."""
    from app.services.llm import LLMQuotaError
    from evals.eval_extraction import run

    stub_run([LLMQuotaError("exhausted")] * 3)
    _, path = await run(ticker=None, limit=None, sleep=0, tag=None, allow_fallback=False)

    assert path is not None
    assert RunArtifact.model_validate_json(path.read_text()).records == []


async def test_run_disables_the_fallback_model_and_restores_it(stub_run, monkeypatch):
    """A silent fallback would put two models' rows under one model heading."""
    from app.config import settings
    from evals.eval_extraction import run

    monkeypatch.setattr(settings, "gemini_fallback_model", "gemini-3.5-flash-lite")
    seen: list[str] = []

    async def record_fallback(filing_text, form_type, company_name, ticker):
        seen.append(settings.gemini_fallback_model)
        return _good_analysis()

    from evals import eval_extraction

    stub_run([_good_analysis()])
    monkeypatch.setattr(eval_extraction, "analyze_filing", record_fallback)

    _, path = await run(ticker=None, limit=None, sleep=0, tag=None, allow_fallback=False)

    assert seen == [""]
    assert settings.gemini_fallback_model == "gemini-3.5-flash-lite"
    assert path is not None
    assert RunArtifact.model_validate_json(path.read_text()).fallback_model == ""


# --- resume (don't pay twice for what already worked) ---

async def _first_run(stub_run, outcomes):
    """A run that leaves an artifact behind for a later --resume to pick up."""
    from evals.eval_extraction import run

    stub_run(outcomes)
    _, path = await run(ticker=None, limit=None, sleep=0, tag=None, allow_fallback=False)
    assert path is not None
    return path


async def test_resume_reuses_successful_extractions_without_calling_the_model(stub_run):
    from app.services.llm import LLMOverloadedError
    from evals.eval_extraction import run

    await _first_run(
        stub_run, [_good_analysis(), LLMOverloadedError("busy"), _good_analysis()]
    )
    attempted = stub_run([_good_analysis()] * 3)  # all would succeed on a re-run
    _, path = await run(
        ticker=None, limit=None, sleep=0, tag=None, allow_fallback=False, resume=True
    )

    # Only the filing that failed costs a request; the other two are read back.
    assert attempted == ["T1"]
    assert path is not None
    artifact = RunArtifact.model_validate_json(path.read_text())
    assert [r.ticker for r in artifact.records] == ["T0", "T1", "T2"]
    assert all(r.error is None for r in artifact.records)


async def test_resume_refuses_to_mix_configurations(stub_run, monkeypatch):
    """A report heading names one model and one MAX_FILING_CHARS — reusing rows
    produced under a different cap would make that heading false, so the calls get re-spent instead."""
    from app.config import settings
    from evals.eval_extraction import run

    await _first_run(stub_run, [_good_analysis(), _good_analysis()])
    monkeypatch.setattr(settings, "max_filing_chars", settings.max_filing_chars // 2)
    attempted = stub_run([_good_analysis()] * 2)
    await run(
        ticker=None, limit=None, sleep=0, tag=None, allow_fallback=False, resume=True
    )

    assert attempted == ["T0", "T1"]


async def test_resume_with_no_prior_artifact_runs_everything(stub_run):
    from evals.eval_extraction import run

    attempted = stub_run([_good_analysis()] * 2)
    await run(
        ticker=None, limit=None, sleep=0, tag=None, allow_fallback=False, resume=True
    )

    assert attempted == ["T0", "T1"]


# --- token pacing (TPM, not RPM, is what binds) ---

async def test_a_second_large_filing_waits_for_the_token_window(stub_run, monkeypatch):
    """One 10-K at the char cap is most of a minute's token pool, so two can't share a window — a real run peaked
    at 247K/250K and started getting 503s; a fixed --sleep can't fix that since what matters is filing size, not count."""
    from app.services import edgar, embeddings
    from evals.eval_extraction import _TOKEN_BUDGET, run

    clock = [0.0]
    slept: list[float] = []

    async def fake_sleep(seconds):
        slept.append(seconds)
        clock[0] += seconds

    monkeypatch.setattr(embeddings, "_now", lambda: clock[0])
    monkeypatch.setattr(embeddings, "_sleep", fake_sleep)

    async def fetch_a_whole_budget(cik, accession_number, primary_document):
        return "x" * int(_TOKEN_BUDGET * embeddings.CHARS_PER_TOKEN)

    stub_run([_good_analysis(), _good_analysis()])
    monkeypatch.setattr(edgar, "fetch_filing_text", fetch_a_whole_budget)

    _, path = await run(ticker=None, limit=None, sleep=0, tag=None, allow_fallback=False)

    assert slept and slept[0] >= embeddings.RATE_WINDOW
    # Paced, not dropped — both filings still get extracted.
    assert path is not None
    assert len(RunArtifact.model_validate_json(path.read_text()).records) == 2


async def test_small_filings_are_not_paced(stub_run, monkeypatch):
    """Most of the golden set is nowhere near the cap — pacing must not add a
    minute per filing when the tokens plainly fit."""
    from app.services import embeddings
    from evals.eval_extraction import run

    slept: list[float] = []

    async def fake_sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(embeddings, "_now", lambda: 0.0)
    monkeypatch.setattr(embeddings, "_sleep", fake_sleep)

    stub_run([_good_analysis()] * 3)
    await run(ticker=None, limit=None, sleep=0, tag=None, allow_fallback=False)

    assert slept == []


async def test_a_503_is_metered_because_the_model_already_read_the_filing(monkeypatch):
    """A 503 still costs tokens, so the retry has to wait out the whole window — only a 429 is refused before the meter.
    Treating a 503 as free let a retried 600k-char filing put two full payloads in one minute, turning the 503 into a 429 that stopped a real run four filings short."""
    from app.services import embeddings
    from app.services.llm import LLMOverloadedError
    from evals import eval_extraction

    clock = [0.0]

    async def fake_sleep(seconds):
        clock[0] += seconds

    monkeypatch.setattr(embeddings, "_now", lambda: clock[0])
    monkeypatch.setattr(embeddings, "_sleep", fake_sleep)
    monkeypatch.setattr(eval_extraction, "_OVERLOAD_BACKOFF", 0.0)

    attempts: list[float] = []

    async def analyze(filing_text, form_type, company_name, ticker):
        attempts.append(clock[0])
        if len(attempts) == 1:
            raise LLMOverloadedError("model overloaded")
        return _good_analysis()

    monkeypatch.setattr(eval_extraction, "analyze_filing", analyze)

    entry = GoldenEntry(
        ticker="T0",
        cik="320193",
        company_name="Co",
        accession_number="0000320193-25-000070",
        primary_document="d.htm",
        fiscal_year=2025,
    )
    budget = eval_extraction._TOKEN_BUDGET
    await eval_extraction._extract_with_overload_retry(
        entry,
        "x" * int(budget * embeddings.CHARS_PER_TOKEN),
        "T0",
        embeddings.TokenPacer(budget=budget),
    )

    assert len(attempts) == 2
    assert attempts[1] - attempts[0] >= embeddings.RATE_WINDOW, (
        "the retry re-sent a full payload inside the same rolling minute"
    )


# --- the README's generated accuracy block ---

def _summary():
    return scoring.RunSummary(
        run_date="2026-08-14",
        model="gemini-3.6-flash",
        max_filing_chars=600_000,
        filings=10,
        accuracy=1.0,
        scored=40,
        correct=40,
    )


def test_readme_summary_carries_the_denominator_and_no_dashes():
    """"100%" means nothing without the field count it was taken over, and the
    README forbids em/en dashes outright (docs/readme-style.md)."""
    block = scoring.render_readme_summary(_summary())

    assert "40" in block and "100.0%" in block
    assert "—" not in block and "–" not in block


def test_rescoring_replaces_the_readme_block_instead_of_stacking_tables(tmp_path, monkeypatch):
    """The marker starts as a bare placeholder and must stay a single block.
    Appending on every score would grow the README a table at a time — exactly what the generated-content rule prevents."""
    from evals import eval_extraction

    readme = tmp_path / "README.md"
    readme.write_text(
        f"## Extraction accuracy\n\nintro\n\n{scoring.README_START}\n\nclosing prose\n"
    )
    monkeypatch.setattr(eval_extraction, "_README_PATH", readme)

    eval_extraction._write_readme_summary(_summary())
    first = readme.read_text()
    eval_extraction._write_readme_summary(_summary())
    second = readme.read_text()

    assert first == second, "a re-score must be idempotent"
    assert second.count(scoring.README_START) == 1
    assert second.count("| 2026-08-14 |") == 1
    # Prose on both sides of the marker survives.
    assert "intro" in second and second.rstrip().endswith("closing prose")


def test_a_readme_without_the_marker_is_left_alone(tmp_path, monkeypatch):
    """Removing the block is a deliberate choice; score must not reinstate it."""
    from evals import eval_extraction

    readme = tmp_path / "README.md"
    readme.write_text("no marker here\n")
    monkeypatch.setattr(eval_extraction, "_README_PATH", readme)

    eval_extraction._write_readme_summary(_summary())

    assert readme.read_text() == "no marker here\n"


# --- golden set integrity ---

def test_golden_set_is_valid_and_diverse():
    """Every entry must survive the same validators that guard EDGAR URLs (a security boundary) —
    reusing them here catches a bad accession number before it reaches a request."""
    path = Path(__file__).parent.parent / "evals" / "golden.json"
    entries = [GoldenEntry.model_validate(e) for e in json.loads(path.read_text())]

    assert len(entries) >= 10
    assert len({e.ticker for e in entries}) == len(entries)

    for entry in entries:
        AnalysisRequest(
            accession_number=entry.accession_number,
            cik=entry.cik,
            ticker=entry.ticker,
            company_name=entry.company_name,
            form_type=entry.form_type,
            primary_document=entry.primary_document,
        )
