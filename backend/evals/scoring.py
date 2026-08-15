"""Pure comparison + report rendering for the extraction eval (roadmap 5.2).

Split out from `eval_extraction.py` on purpose: everything here is a pure
function over plain data, so the scoring rules are covered by the normal pytest
run with no network, no Gemini key, and no quota spent. The module that fetches
filings and calls the LLM imports these; nothing here imports it back.

The ground truth is SEC's own XBRL (`services/xbrl.py`) — the as-reported
figures the filer tagged — so no human labelling is involved anywhere.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


# ±1% absorbs rounding and scale wording ("$394.3 billion" vs 394,328,000,000)
# without letting a genuinely wrong figure through.
TOLERANCE = 0.01

# Below this, a relative comparison is meaningless — a company reporting $0
# revenue makes any absolute miss an infinite percentage error.
_ZERO_ABS_TOLERANCE = 1.0

# A factor-of-1000 family miss means the model read "(in thousands)" and never
# applied it — the single most common and most diagnosable extraction failure.
_SCALE_FACTORS = (1e3, 1e6, 1e9)

Verdict = Literal["correct", "wrong", "no_ground_truth", "error"]

_SYMBOLS: dict[str, str] = {
    "correct": "✓",
    "wrong": "✗",
    "no_ground_truth": "—",
    "error": "!",
}


# --- data carried between `run` and `score` ---

class GoldenEntry(BaseModel):
    """One filing in the golden set.

    `fiscal_year` is the XBRL **period-end** year, which is not always the year
    the company calls it: `_annual_values` keys on the end date, so a retailer
    whose FY2024 ends in Feb 2025 appears as 2025. `build-golden` prints the
    available series so this can be checked at authoring time.
    """

    ticker: str
    cik: str
    company_name: str
    accession_number: str
    primary_document: str
    form_type: str = "10-K"
    fiscal_year: int
    note: str = ""


class ExtractionRecord(BaseModel):
    """What the LLM returned for one golden entry, as saved by `run`."""

    ticker: str
    cik: str
    accession_number: str
    fiscal_year: int
    revenue_current: float | None = None
    revenue_yoy_change_pct: float | None = None
    net_income_current: float | None = None
    net_income_yoy_change_pct: float | None = None
    error: str | None = None


class RunArtifact(BaseModel):
    """A complete `run`, persisted so scoring never needs to re-spend quota."""

    run_date: str
    model: str
    fallback_model: str = ""
    max_filing_chars: int
    records: list[ExtractionRecord] = []


class GroundTruth(BaseModel):
    """XBRL figures for one filing's fiscal year, plus the surrounding series.

    The full series is carried so a wrong value can be recognised as the *prior
    year's* figure — the model reading the comparative column of the statement.
    """

    fiscal_year: int
    revenue: float | None = None
    revenue_prior: float | None = None
    net_income: float | None = None
    net_income_prior: float | None = None
    revenue_series: dict[int, float] = {}
    net_income_series: dict[int, float] = {}


class FieldScore(BaseModel):
    verdict: Verdict
    detail: str = ""

    @property
    def symbol(self) -> str:
        return _SYMBOLS[self.verdict]


class RecordScore(BaseModel):
    ticker: str
    fiscal_year: int
    revenue: FieldScore
    net_income: FieldScore
    revenue_yoy_sign: FieldScore
    net_income_yoy_sign: FieldScore
    error: str | None = None

    @property
    def fields(self) -> list[FieldScore]:
        return [self.revenue, self.net_income, self.revenue_yoy_sign, self.net_income_yoy_sign]


class Totals(BaseModel):
    correct: int = 0
    wrong: int = 0
    no_ground_truth: int = 0
    errors: int = 0

    @property
    def scored(self) -> int:
        """Denominator: fields where XBRL actually had something to compare."""
        return self.correct + self.wrong

    @property
    def accuracy(self) -> float | None:
        return self.correct / self.scored if self.scored else None


# --- comparison ---

def within_tolerance(value: float, truth: float, tolerance: float = TOLERANCE) -> bool:
    """Relative comparison, with an absolute fallback when truth is zero."""
    if truth == 0:
        return abs(value) <= _ZERO_ABS_TOLERANCE
    return abs(value - truth) / abs(truth) <= tolerance


def classify_failure(
    value: float, truth: float, series: dict[int, float] | None = None
) -> str:
    """Name *why* a figure is wrong — the most useful column in the report.

    Order matters: a sign flip and a scale error can both be true of the same
    ratio, and the sign is the more specific claim.
    """
    if truth != 0 and within_tolerance(abs(value), abs(truth)) and (value < 0) != (truth < 0):
        return "sign"

    if truth != 0:
        ratio = abs(value) / abs(truth)
        for factor in _SCALE_FACTORS:
            if within_tolerance(ratio, factor):
                return f"scale (×{factor:.0e})"
            if within_tolerance(ratio, 1 / factor):
                return f"scale (÷{factor:.0e})"

    for year, other in (series or {}).items():
        if other != truth and within_tolerance(value, other):
            return f"period (matches FY{year})"

    return "other"


def score_value(
    value: float | None, truth: float | None, series: dict[int, float] | None = None
) -> FieldScore:
    """Score one extracted figure against XBRL.

    A missing *truth* is not a model failure, so it scores `no_ground_truth` and
    is excluded from the denominator — folding those in as misses would
    understate real accuracy. It happens when no us-gaap concept candidate
    covers the year at all, which is rarer than it looks: the obvious suspects
    (banks) do tag `Revenues`, and what actually causes gaps is a filer moving
    between concepts across eras.
    """
    if truth is None:
        return FieldScore(verdict="no_ground_truth")
    if value is None:
        return FieldScore(verdict="wrong", detail="missing")
    if within_tolerance(value, truth):
        return FieldScore(verdict="correct")
    return FieldScore(verdict="wrong", detail=classify_failure(value, truth, series))


def score_yoy_sign(
    yoy_pct: float | None, current: float | None, prior: float | None
) -> FieldScore:
    """Does the reported direction of change match XBRL's?

    Only the sign is checked, not the magnitude: the model is told to compute
    the percentage over `|prior|`, which for a company moving from a loss to a
    smaller loss gives a positive number that agrees with the delta's sign —
    but the magnitude depends on a denominator convention XBRL doesn't share.
    """
    if current is None or prior is None:
        return FieldScore(verdict="no_ground_truth")
    delta = current - prior
    if delta == 0:
        return FieldScore(verdict="no_ground_truth")
    if yoy_pct is None:
        return FieldScore(verdict="wrong", detail="missing")
    if yoy_pct == 0:
        return FieldScore(verdict="wrong", detail="sign")
    return (
        FieldScore(verdict="correct")
        if (yoy_pct > 0) == (delta > 0)
        else FieldScore(verdict="wrong", detail="sign")
    )


def score_record(record: ExtractionRecord, truth: GroundTruth) -> RecordScore:
    if record.error:
        failed = FieldScore(verdict="error", detail=record.error)
        return RecordScore(
            ticker=record.ticker,
            fiscal_year=record.fiscal_year,
            revenue=failed,
            net_income=failed,
            revenue_yoy_sign=failed,
            net_income_yoy_sign=failed,
            error=record.error,
        )

    return RecordScore(
        ticker=record.ticker,
        fiscal_year=record.fiscal_year,
        revenue=score_value(record.revenue_current, truth.revenue, truth.revenue_series),
        net_income=score_value(
            record.net_income_current, truth.net_income, truth.net_income_series
        ),
        revenue_yoy_sign=score_yoy_sign(
            record.revenue_yoy_change_pct, truth.revenue, truth.revenue_prior
        ),
        net_income_yoy_sign=score_yoy_sign(
            record.net_income_yoy_change_pct, truth.net_income, truth.net_income_prior
        ),
    )


def totals(scores: list[RecordScore]) -> Totals:
    result = Totals()
    for score in scores:
        for field in score.fields:
            if field.verdict == "correct":
                result.correct += 1
            elif field.verdict == "wrong":
                result.wrong += 1
            elif field.verdict == "no_ground_truth":
                result.no_ground_truth += 1
            else:
                result.errors += 1
    return result


# --- rendering ---

class RunSummary(BaseModel):
    """One line of the run-history table."""

    run_date: str
    model: str
    max_filing_chars: int
    filings: int
    accuracy: float | None
    scored: int
    correct: int


def summarize(artifact: RunArtifact, scores: list[RecordScore]) -> RunSummary:
    result = totals(scores)
    return RunSummary(
        run_date=artifact.run_date,
        model=artifact.model,
        max_filing_chars=artifact.max_filing_chars,
        filings=len(artifact.records),
        accuracy=result.accuracy,
        scored=result.scored,
        correct=result.correct,
    )


def _pct(value: float | None) -> str:
    return f"{value * 100:.1f}%" if value is not None else "n/a"


def _notes(score: RecordScore) -> str:
    if score.error:
        return f"run failed: {score.error}"
    parts: list[str] = []
    labels = ("revenue", "net income", "revenue YoY", "net income YoY")
    for label, field in zip(labels, score.fields):
        if field.verdict == "wrong" and field.detail:
            parts.append(f"{label}: {field.detail}")
        elif field.verdict == "no_ground_truth":
            parts.append(f"{label}: no XBRL concept")
    return "; ".join(parts)


# The README's generated block. Fenced by markers so a re-score replaces it in
# place instead of appending a second table.
README_START = "<!-- ACCURACY_TABLE -->"
README_END = "<!-- /ACCURACY_TABLE -->"


def render_readme_summary(summary: RunSummary) -> str:
    """Headline figures only, for the README's generated accuracy block.

    `docs/evals.md` is gitignored, so a public reader can never open it: any
    number that has to reach them must live in the README itself. It stays a
    summary rather than the per-filing table because that section serves a
    60-second skim, and the full report is one command away.

    Generated, never hand-written. `docs/readme-style.md` lists the hand-filled
    version as a known gap for exactly one reason: an accuracy figure typed by
    hand goes stale the next time the eval runs and nothing catches it. Carries
    the scored-field count as well as the percentage, because "100%" means
    nothing without the denominator it was taken over.

    No dashes of any kind in the output — the README forbids them (same doc).
    """
    return "\n".join(
        [
            README_START,
            "",
            "| Run | Model | Filings | Fields scored | Correct |",
            "|---|---|---|---|---|",
            f"| {summary.run_date} | `{summary.model}` | {summary.filings} "
            f"| {summary.scored} | {_pct(summary.accuracy)} |",
            "",
            README_END,
        ]
    )


_PREAMBLE = """# Extraction accuracy

Scores what the LLM reads out of a filing's **text** against what the filer
**tagged in XBRL** for the same fiscal year — SEC's own structured data, so the
ground truth is authoritative and needs no labelling.

Method: for each filing in `backend/evals/golden.json`, the real pipeline runs
(`edgar.fetch_filing_text` → `llm.analyze_filing`, section targeting and
truncation included) and the result is compared against the filer's own us-gaap
tags for that fiscal year. A figure counts correct within **±1%**. Fields where
XBRL has no value are marked `—` and excluded from the denominator rather than
counted as misses — a gap in SEC's data is not a model error. Wrong figures are
classified (`scale`, `sign`, `period`) so a miss says *why*, not just that it
happened.

Reproduce with `cd backend && python -m evals.eval_extraction run`. Never runs
in CI: it spends real Gemini quota.
"""


def render_markdown(
    artifact: RunArtifact,
    scores: list[RecordScore],
    history: list[RunSummary],
    baseline: RunSummary | None = None,
) -> str:
    result = totals(scores)
    lines = [_PREAMBLE]

    lines.append(
        f"## Latest run — {artifact.run_date} · `{artifact.model}` · "
        f"MAX_FILING_CHARS={artifact.max_filing_chars:,}"
    )
    lines.append("")
    if not artifact.fallback_model:
        lines.append(
            "_Model fallback disabled for this run, so every row below was served "
            "by the model named above._"
        )
        lines.append("")
    lines.append("| Ticker | FY | Revenue | Net income | Rev YoY sign | NI YoY sign | Notes |")
    lines.append("|---|---|---|---|---|---|---|")
    for score in scores:
        lines.append(
            f"| {score.ticker} | {score.fiscal_year} | {score.revenue.symbol} | "
            f"{score.net_income.symbol} | {score.revenue_yoy_sign.symbol} | "
            f"{score.net_income_yoy_sign.symbol} | {_notes(score)} |"
        )
    lines.append("")

    summary = (
        f"**Overall: {result.correct}/{result.scored} scored fields correct "
        f"({_pct(result.accuracy)})**"
    )
    if result.no_ground_truth:
        summary += f" · {result.no_ground_truth} field(s) had no XBRL ground truth"
    if result.errors:
        summary += f" · {result.errors} field(s) not reached (run error)"
    lines.append(summary)
    lines.append("")

    if baseline is not None:
        lines.append(_delta_line(baseline, result.accuracy))
        lines.append("")

    lines.append("## Run history")
    lines.append("")
    lines.append("| Date | Model | MAX_FILING_CHARS | Filings | Overall |")
    lines.append("|---|---|---|---|---|")
    for run in sorted(history, key=lambda r: r.run_date, reverse=True):
        lines.append(
            f"| {run.run_date} | `{run.model}` | {run.max_filing_chars:,} | "
            f"{run.filings} | {_pct(run.accuracy)} ({run.correct}/{run.scored}) |"
        )
    lines.append("")
    lines.append(
        "_Every row is re-scored from its saved artifact under "
        "`backend/evals/results/` on each `score`, so the whole history always "
        "reflects the current scoring rules._"
    )
    lines.append("")
    return "\n".join(lines)


def _delta_line(baseline: RunSummary, accuracy: float | None) -> str:
    if accuracy is None or baseline.accuracy is None:
        return f"Δ vs baseline ({baseline.run_date}): not comparable."
    delta = (accuracy - baseline.accuracy) * 100
    direction = "no change" if abs(delta) < 0.05 else f"{delta:+.1f} pts"
    return (
        f"**Δ vs baseline** ({baseline.run_date}, `{baseline.model}`, "
        f"MAX_FILING_CHARS={baseline.max_filing_chars:,}): {direction} "
        f"({_pct(baseline.accuracy)} → {_pct(accuracy)})"
    )


def regressions(
    current: list[RecordScore], baseline: list[RecordScore]
) -> list[str]:
    """Fields that were correct in the baseline and are not now."""
    before = {score.ticker: score for score in baseline}
    labels = ("revenue", "net income", "revenue YoY", "net income YoY")
    found: list[str] = []
    for score in current:
        was = before.get(score.ticker)
        if was is None:
            continue
        for label, now_field, was_field in zip(labels, score.fields, was.fields):
            if was_field.verdict == "correct" and now_field.verdict == "wrong":
                detail = f" ({now_field.detail})" if now_field.detail else ""
                found.append(f"{score.ticker} {label}{detail}")
    return found
