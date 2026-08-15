"""Score LLM financial extraction against SEC XBRL ground truth (roadmap 5.2).

Lives outside `tests/` because it hits real EDGAR and spends real Gemini quota.
Run manually, never in CI:

    cd backend && python -m evals.eval_extraction build-golden AAPL MSFT JPM ...
    cd backend && python -m evals.eval_extraction run
    cd backend && python -m evals.eval_extraction score --baseline evals/results/2026-08-01.json

The work is split in two so the expensive half runs as rarely as possible:

  `run`   — fetch each golden filing and call the LLM. **The only metered step**:
            one `generateContent` per filing (10 for the default golden set),
            plus one per malformed-JSON retry. Saves the raw extractions to
            `evals/results/<date>.json`.
  `score` — read a saved artifact, fetch XBRL ground truth, render `docs/evals.md`.
            Free, and after the first call served entirely from `evals/.cache/`.

That split is what makes re-scoring after a rule change cost nothing, lets the
comparison logic live in `evals/scoring.py` under normal pytest, and — because
the ground truth is pinned on disk — keeps a months-apart before/after delta
honest when a company restates in between.

Which APIs a full run touches, and what they cost:

  Gemini generateContent   10   the only quota-consuming calls (GEMINI_MODEL)
  Gemini embeddings         0   this never touches the Q&A path
  Supabase                  0   `analyze_filing` is called directly, so nothing
                                is written to `analyses` and no cache row is made
  EDGAR filing HTML        10   free, throttled, needs SEC_USER_AGENT
  XBRL companyconcept   20-30   free; `score` only, and disk-cached after once
                                (2-5 per company: revenue candidates until one
                                covers the year, plus net income)

Two free-tier ceilings shape a run, and requests-per-day is the less awkward one:
tokens-per-minute binds first, since one 10-K at the 600k-char cap is most of a
minute's pool by itself (see _TOKEN_BUDGET). Runs are therefore paced by
estimated tokens, not by a fixed sleep — and because an interrupted run is
normal rather than exceptional, `run --resume` reuses what already succeeded
instead of paying for it twice.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import logging
import sys
from pathlib import Path

from app.config import settings
from app.models.schemas import AnnualFinancials
from app.services import edgar, xbrl
from app.services.embeddings import TokenPacer, estimate_tokens
from app.services.llm import LLMError, LLMOverloadedError, LLMQuotaError, analyze_filing
from evals import scoring
from evals.scoring import (
    ExtractionRecord,
    GoldenEntry,
    GroundTruth,
    RunArtifact,
)

logger = logging.getLogger("evals")

_HERE = Path(__file__).parent
_GOLDEN_PATH = _HERE / "golden.json"
_RESULTS_DIR = _HERE / "results"
_CACHE_DIR = _HERE / ".cache"
_REPORT_PATH = _HERE.parent.parent / "docs" / "evals.md"
# The public half of the report: `docs/` is gitignored, README.md is not.
_README_PATH = _HERE.parent.parent / "README.md"

# Free-tier Flash is roughly 10-15 RPM. 20s between filings keeps a full run
# comfortably under that; EDGAR downloads dominate the wall clock anyway.
_DEFAULT_SLEEP = 20.0

# RPM was never what bit this harness — TOKENS per minute was. gemini-3.6-flash's
# free tier meters 250k input tokens/minute, and a single 10-K at the 600k-char
# cap is most of that pool on its own, so two big filings inside one rolling
# minute cannot both fit. A real run peaked at 247K/250K and the model began
# answering 503, which cost filings and looked like an outage. A fixed --sleep
# can't fix that: what matters is how large the filings were, not how many.
#
# So the same rolling-window TokenPacer that paces embeddings meters this too,
# with the analysis model's ceiling. Requests are metered on their *estimated*
# size (there's no usage figure to read back from analyze_filing), using the
# deliberately pessimistic 1.8 chars/token calibrated on filing prose — an
# over-estimate costs wall clock, an under-estimate costs a 503.
_TOKENS_PER_MINUTE = 250_000
# Headroom for estimation error and the prompt template's own ~1k tokens.
_TOKEN_BUDGET = 200_000

# The golden set reaches back several years, past get_annual_financials' default
# window of 8.
_MAX_YEARS = 20

_BUILD_FORM_TYPES = ["10-K"]


# --- golden set ---

def load_golden() -> list[GoldenEntry]:
    entries = json.loads(_GOLDEN_PATH.read_text())
    return [GoldenEntry.model_validate(entry) for entry in entries]


async def build_golden(tickers: list[str]) -> int:
    """Resolve tickers to their latest 10-K and write evals/golden.json.

    EDGAR only — no LLM, no quota. Hand-transcribing accession numbers is the
    main way a golden set goes silently wrong, so this resolves them, then
    prints each company's XBRL years for review: `fiscal_year` has to be the
    period-**end** year, which for a Jan/Feb fiscal-year end is one more than
    the year the company itself calls it.
    """
    await edgar.load_tickers()
    entries: list[GoldenEntry] = []

    for ticker in tickers:
        matches = edgar.search_tickers(ticker, limit=1)
        if not matches or matches[0].ticker.upper() != ticker.upper():
            logger.warning("%s — no exact ticker match, skipping", ticker)
            continue
        company = matches[0]

        filings = await edgar.get_filings(
            company.cik, form_types=_BUILD_FORM_TYPES, limit=1
        )
        if not filings:
            logger.warning("%s — no 10-K in EDGAR's recent block, skipping", ticker)
            continue
        filing = filings[0]

        years = await xbrl.get_annual_financials(company.cik, max_years=_MAX_YEARS)
        fiscal_year = _pick_fiscal_year(years, filing.filing_date)
        if fiscal_year is None:
            logger.warning(
                "%s — no XBRL annual data at or before %s, skipping",
                ticker,
                filing.filing_date,
            )
            continue

        # Resolve ground truth the same way `score` will — otherwise the review
        # output here disagrees with what the eval actually compares against.
        truth = await build_ground_truth(company.cik, fiscal_year, company.ticker)
        note = ""
        if truth.revenue is None:
            note = "no XBRL revenue concept covers this year"
        if truth.revenue_prior is None or truth.net_income_prior is None:
            note = (note + "; " if note else "") + "prior year missing (YoY unscoreable)"

        entries.append(
            GoldenEntry(
                ticker=company.ticker,
                cik=company.cik,
                company_name=company.name,
                accession_number=filing.accession_number,
                primary_document=filing.primary_document,
                form_type=filing.form_type,
                fiscal_year=fiscal_year,
                note=note,
            )
        )
        logger.info(
            "%-6s FY%d  filed %s  %s",
            company.ticker,
            fiscal_year,
            filing.filing_date,
            filing.accession_number,
        )
        logger.info(
            "        XBRL years %s | revenue=%s (prior %s) net_income=%s (prior %s)",
            [y.fiscal_year for y in years],
            _fmt(truth.revenue),
            _fmt(truth.revenue_prior),
            _fmt(truth.net_income),
            _fmt(truth.net_income_prior),
        )
        if note:
            logger.warning("        %s", note)

    if not entries:
        logger.error("Nothing resolved — golden.json left unchanged.")
        return 1

    _GOLDEN_PATH.write_text(
        json.dumps([e.model_dump() for e in entries], indent=2) + "\n"
    )
    logger.info("Wrote %d entries to %s", len(entries), _GOLDEN_PATH)
    logger.info("Review the fiscal years above before running the eval.")
    return 0


def _pick_fiscal_year(years: list[AnnualFinancials], filing_date: str) -> int | None:
    """Latest tagged year at or before the filing year.

    A 10-K is filed within ~3 months of its period end, so the newest series
    entry not *after* the filing year is the year that filing reports on —
    including the Jan/Feb-year-end case, where the period-end year and the
    filing year are the same.
    """
    filed_year = int(filing_date[:4])
    candidates = [
        y.fiscal_year
        for y in years
        if y.fiscal_year <= filed_year and (y.revenue is not None or y.net_income is not None)
    ]
    return max(candidates) if candidates else None


def _fmt(value: float | None) -> str:
    return f"{value:,.0f}" if value is not None else "None"


# --- run (spends quota) ---

# A Gemini 503 means the model is momentarily busy, and on a batch of ten
# filings that is worth waiting out — the first real run of this harness lost
# eight filings to one transient spike. A 429 is the opposite: the day's
# requests are gone and there is no window to wait for, so that one stops the
# run. `LLMOverloadedError` subclasses `LLMQuotaError`, so order these excepts
# narrowest-first.
_OVERLOAD_ATTEMPTS = 3
_OVERLOAD_BACKOFF = 30.0

# One filing exhausting its retries is not evidence of an outage: overload
# tracks request size as well as load, and the largest filing in the set (JPM,
# at the full 600k cap) hit it twice in a run where every other filing sailed
# through. So a spent-out filing is recorded as an error and the run continues —
# only this many *consecutive* overload write-offs means the model really is
# unavailable and there's no point working through the rest.
_OVERLOAD_GIVE_UP = 3

# `_generate` wraps everything that isn't a 429/503 in a plain LLMError,
# including a dropped TCP connection — one of those cost a filing on the first
# real run. Retrying *those* is right; retrying a malformed-output LLMError is
# not, because analyze_filing already re-sampled once and a second failure is a
# real extraction result the eval exists to measure.
_TRANSIENT_CAUSES = frozenset(
    {
        "RemoteDisconnected",
        "ProtocolError",
        "ConnectionError",
        "ConnectError",
        "ConnectTimeout",
        "ReadTimeout",
        "ReadError",
        "TimeoutException",
        "ServerDisconnectedError",
    }
)


def _is_transport_failure(exc: BaseException, depth: int = 6) -> bool:
    """Walk the cause/context chain looking for a connection-level failure."""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and depth > 0 and id(current) not in seen:
        if type(current).__name__ in _TRANSIENT_CAUSES:
            return True
        seen.add(id(current))
        current = current.__cause__ or current.__context__
        depth -= 1
    return False


async def _extract_with_overload_retry(
    entry: GoldenEntry, filing_text: str, label: str, pacer: TokenPacer
):
    delay = _OVERLOAD_BACKOFF
    tokens = estimate_tokens(filing_text)
    for attempt in range(_OVERLOAD_ATTEMPTS):
        last = attempt == _OVERLOAD_ATTEMPTS - 1
        try:
            # Every attempt pays tokens, so pace inside the retry loop, not
            # around it.
            await pacer.acquire(tokens)
            analysis = await analyze_filing(
                filing_text=filing_text,
                form_type=entry.form_type,
                company_name=entry.company_name,
                ticker=entry.ticker,
            )
            pacer.record(tokens)
            return analysis
        except LLMQuotaError as exc:
            if isinstance(exc, LLMOverloadedError):
                # A 503 still costs tokens: the model *took* the input and then
                # failed to answer, so the server metered it even though nothing
                # came back. Only a 429 is refused before the meter. Leaving
                # 503s unrecorded is what let a retried 600k-char filing put two
                # full payloads into one rolling minute and turn the 503 into a
                # 429 — recording makes the next `acquire` wait out the window,
                # which is the right backoff and longer than _OVERLOAD_BACKOFF.
                #
                # Recorded before the write-off branch, not after: the attempt
                # that exhausts the retries is metered like any other, and the
                # *next filing* is the one that pays for it. Skipping it let the
                # filing after a written-off one start with a window that looked
                # empty but wasn't.
                pacer.record(tokens)
            # A spent daily pool has no window to wait for — let it stop the run.
            if not isinstance(exc, LLMOverloadedError) or last:
                raise
            reason = "model overloaded"
        except LLMError as exc:
            if not _is_transport_failure(exc) or last:
                raise
            reason = "connection dropped"

        logger.warning(
            "%s — %s, retrying in %.0fs (%d/%d)",
            label,
            reason,
            delay,
            attempt + 1,
            _OVERLOAD_ATTEMPTS - 1,
        )
        await asyncio.sleep(delay)
        delay *= 2
    raise AssertionError("unreachable")


async def run(
    ticker: str | None,
    limit: int | None,
    sleep: float,
    tag: str | None,
    allow_fallback: bool,
    resume: bool = False,
    resume_from: Path | None = None,
) -> tuple[int, Path | None]:
    entries = load_golden()
    if ticker:
        entries = [e for e in entries if e.ticker == ticker]
    if limit is not None:
        entries = entries[:limit]
    if not entries:
        logger.error("No golden entries selected.")
        return 1, None

    run_date = datetime.date.today().isoformat()
    target = _artifact_path(run_date, tag)
    reusable: dict[str, ExtractionRecord] = {}
    if resume or resume_from is not None:
        reusable = _reusable_records(resume_from or target, allow_fallback)
    elif target.exists():
        logger.warning(
            "%s already exists and will be overwritten — --resume keeps its "
            "extractions, --tag keeps both files.",
            target.name,
        )

    # A run that silently falls back to GEMINI_FALLBACK_MODEL reports a model
    # name that isn't true of every row — and that model is the same pool Q&A
    # runs on, so it would also eat the live app's question budget. Off by
    # default: quota exhaustion should stop the run, not quietly change models.
    original_fallback = settings.gemini_fallback_model
    if not allow_fallback:
        settings.gemini_fallback_model = ""

    records: list[ExtractionRecord] = []
    unreached: list[str] = []
    consecutive_overloads = 0
    pacer = TokenPacer(budget=_TOKEN_BUDGET)
    try:
        for position, entry in enumerate(entries):
            label = f"{entry.ticker} FY{entry.fiscal_year}"

            prior = reusable.get(entry.accession_number)
            if prior is not None:
                # Costs nothing and changes nothing: same model, same cap, same
                # filing, so the saved extraction is the extraction this call
                # would make. Checked in _reusable_records.
                logger.info("%s — reusing saved extraction (no LLM call)", label)
                records.append(prior)
                continue

            try:
                logger.info("%s — fetching filing", label)
                filing_text = await edgar.fetch_filing_text(
                    cik=entry.cik,
                    accession_number=entry.accession_number,
                    primary_document=entry.primary_document,
                )
                if not filing_text.strip():
                    raise ValueError("filing text was empty")

                logger.info(
                    "%s — %d chars (~%d tokens) → LLM",
                    label,
                    len(filing_text),
                    estimate_tokens(filing_text),
                )
                analysis = await _extract_with_overload_retry(
                    entry, filing_text, label, pacer
                )
                records.append(
                    ExtractionRecord(
                        ticker=entry.ticker,
                        cik=entry.cik,
                        accession_number=entry.accession_number,
                        fiscal_year=entry.fiscal_year,
                        revenue_current=analysis.revenue.current,
                        revenue_yoy_change_pct=analysis.revenue.yoy_change_pct,
                        net_income_current=analysis.net_income.current,
                        net_income_yoy_change_pct=analysis.net_income.yoy_change_pct,
                    )
                )
                consecutive_overloads = 0
                logger.info(
                    "%s — revenue=%s net_income=%s",
                    label,
                    _fmt(analysis.revenue.current),
                    _fmt(analysis.net_income.current),
                )

            except LLMOverloadedError as exc:
                consecutive_overloads += 1
                logger.error(
                    "%s — still overloaded after %d attempts, writing it off (%d in a row)",
                    label,
                    _OVERLOAD_ATTEMPTS,
                    consecutive_overloads,
                )
                records.append(
                    ExtractionRecord(
                        ticker=entry.ticker,
                        cik=entry.cik,
                        accession_number=entry.accession_number,
                        fiscal_year=entry.fiscal_year,
                        error=f"overloaded: {exc}",
                    )
                )
                if consecutive_overloads >= _OVERLOAD_GIVE_UP:
                    unreached = [
                        f"{e.ticker} FY{e.fiscal_year}" for e in entries[position + 1 :]
                    ]
                    logger.error(
                        "%d filings overloaded in a row — the model is unavailable, "
                        "not just busy. Stopping with %d unreached; this is not a "
                        "quota problem, so re-run later.",
                        consecutive_overloads,
                        len(unreached),
                    )
                    break

            except LLMQuotaError:
                # Nothing to wait out within a run — the daily pool is the daily
                # pool. Stop, keep what was extracted, and say what was missed.
                unreached = [f"{e.ticker} FY{e.fiscal_year}" for e in entries[position:]]
                logger.error(
                    "%s — Gemini quota exhausted. Stopping with %d filing(s) "
                    "unreached; extractions so far are kept.",
                    label,
                    len(unreached),
                )
                break

            except Exception as exc:
                logger.exception("%s — failed", label)
                records.append(
                    ExtractionRecord(
                        ticker=entry.ticker,
                        cik=entry.cik,
                        accession_number=entry.accession_number,
                        fiscal_year=entry.fiscal_year,
                        error=f"{type(exc).__name__}: {exc}",
                    )
                )

            if sleep > 0 and position < len(entries) - 1:
                await asyncio.sleep(sleep)
    finally:
        settings.gemini_fallback_model = original_fallback

    artifact = RunArtifact(
        run_date=run_date,
        model=settings.gemini_model,
        fallback_model="" if not allow_fallback else original_fallback,
        max_filing_chars=settings.max_filing_chars,
        records=records,
    )
    _write_artifact(artifact, target)
    logger.info("Wrote %d extraction(s) to %s", len(records), target)
    if unreached:
        # Not always quota — a sustained overload stops a run the same way.
        logger.info("Not attempted: %s", ", ".join(unreached))
        logger.info("Resume without re-spending what succeeded: run --resume")

    failed = sum(1 for r in records if r.error)
    return (1 if failed or unreached else 0), target


def _artifact_path(run_date: str, tag: str | None) -> Path:
    name = f"{run_date}-{tag}.json" if tag else f"{run_date}.json"
    return _RESULTS_DIR / name


def _write_artifact(artifact: RunArtifact, path: Path) -> None:
    _RESULTS_DIR.mkdir(exist_ok=True)
    path.write_text(artifact.model_dump_json(indent=2) + "\n")


def _reusable_records(
    path: Path, allow_fallback: bool
) -> dict[str, ExtractionRecord]:
    """Successful extractions from a previous run, keyed by accession number.

    Runs get interrupted — a 503 spike, a dropped connection, a spent daily pool —
    and re-extracting what already worked spends quota to learn nothing. Only
    successful records come back: an errored one is exactly what a re-run is for.

    Refuses to reuse across a settings change. A report names one model and one
    MAX_FILING_CHARS in its heading, so mixing in rows produced under different
    ones would make that heading false for part of the table — the same reason
    `run` disables the fallback model. Better to re-spend the calls than to
    publish an accuracy figure that isn't about a single configuration.
    """
    if not path.exists():
        logger.info("Nothing to resume from at %s — running every filing.", path.name)
        return {}

    prior = load_artifact(path)
    expected_fallback = settings.gemini_fallback_model if allow_fallback else ""
    mismatches = [
        f"{name}: {was!r} → {now!r}"
        for name, was, now in (
            ("model", prior.model, settings.gemini_model),
            ("fallback_model", prior.fallback_model, expected_fallback),
            ("max_filing_chars", prior.max_filing_chars, settings.max_filing_chars),
        )
        if was != now
    ]
    if mismatches:
        logger.warning(
            "%s was produced under different settings (%s) — not resuming from it; "
            "every filing will be re-extracted.",
            path.name,
            "; ".join(mismatches),
        )
        return {}

    reusable = {r.accession_number: r for r in prior.records if not r.error}
    logger.info(
        "Resuming from %s: %d extraction(s) reused, %d errored record(s) will be retried.",
        path.name,
        len(reusable),
        sum(1 for r in prior.records if r.error),
    )
    return reusable


# --- ground truth (free, cached) ---

async def series_covering(cik: str, concepts: list[str], year: int) -> dict[int, float]:
    """First concept candidate that has a value **for `year`**, oldest→newest.

    Deliberately not `xbrl._annual_series`. That one answers "which concept is
    this company's current revenue line?", which is the right question for a
    trend chart and the wrong one here: a golden entry names a specific fiscal
    year, and for an older year the current concept may not cover it at all.
    Pfizer is both cases in one company — `Revenues` from FY2020 on,
    `RevenueFromContractWithCustomerExcludingAssessedTax` before that.

    (`_annual_series` used to take the first candidate with *any* data, which
    left Pfizer's chart with no revenue for FY2024-25. Fixed in xbrl.py; this
    function is still year-targeted for the reason above, not as a workaround.)

    Year-targeted rather than merged across concepts on purpose: two revenue
    concepts are not the same measure (product revenue vs total revenues), so
    unioning them by year would build a series that silently changes definition
    partway along. The prior year is read from the *same* concept for exactly
    that reason.
    """
    for concept in concepts:
        data = await xbrl._fetch_concept(cik, concept)
        if data is None:
            continue
        values = xbrl._annual_values(data)
        if year in values:
            return values
    return {}


async def ground_truth_for(record: ExtractionRecord, refresh: bool = False) -> GroundTruth:
    """XBRL figures for one filing's fiscal year, pinned to disk.

    Caching is not primarily about the ~4 requests it saves per company. A
    restatement landing between two `score` runs would otherwise change a
    months-old baseline's numbers with no code change, which is exactly the
    comparison this harness exists to make. `--refresh-xbrl` re-pulls.
    """
    _CACHE_DIR.mkdir(exist_ok=True)
    path = _CACHE_DIR / f"truth-{record.cik}-{record.fiscal_year}.json"
    if path.exists() and not refresh:
        return GroundTruth.model_validate_json(path.read_text())

    truth = await build_ground_truth(record.cik, record.fiscal_year, record.ticker)
    path.write_text(truth.model_dump_json(indent=2) + "\n")
    return truth


async def build_ground_truth(cik: str, fiscal_year: int, ticker: str) -> GroundTruth:
    revenue = await series_covering(cik, xbrl._REVENUE_CONCEPTS, fiscal_year)
    net_income = await series_covering(cik, xbrl._NET_INCOME_CONCEPTS, fiscal_year)

    if not revenue and not net_income:
        # Loudly, not as a silent "—": no candidate concept covering the year at
        # all usually means golden.json is mislabelled (the company's own fiscal
        # year label instead of the period-END year), and scoring it as "no
        # ground truth" would hide that.
        raise ValueError(
            f"{ticker}: no revenue or net-income concept covers FY{fiscal_year} — "
            f"check golden.json's fiscal_year (it must be the period-END year)."
        )

    return GroundTruth(
        fiscal_year=fiscal_year,
        revenue=revenue.get(fiscal_year),
        revenue_prior=revenue.get(fiscal_year - 1),
        net_income=net_income.get(fiscal_year),
        net_income_prior=net_income.get(fiscal_year - 1),
        revenue_series=revenue,
        net_income_series=net_income,
    )


async def score_artifact(
    artifact: RunArtifact, refresh: bool = False
) -> list[scoring.RecordScore]:
    scores: list[scoring.RecordScore] = []
    for record in artifact.records:
        if record.error:
            scores.append(scoring.score_record(record, GroundTruth(fiscal_year=record.fiscal_year)))
            continue
        truth = await ground_truth_for(record, refresh=refresh)
        scores.append(scoring.score_record(record, truth))
    return scores


# --- score (free) ---

def load_artifact(path: Path) -> RunArtifact:
    return RunArtifact.model_validate_json(path.read_text())


def _write_readme_summary(summary: scoring.RunSummary) -> None:
    """Replace the README's generated accuracy block in place.

    The README is the only file here a stranger can read (`docs/` and `tasks/`
    are gitignored), so the headline number has to reach it somehow — and by
    the tool, not by hand, or it silently goes stale one run later.

    An absent start marker is not an error: someone may have removed the block
    deliberately, and a score run shouldn't put it back. A start marker with no
    end is the first write, when the marker is still the bare placeholder.
    """
    if not _README_PATH.exists():
        return

    text = _README_PATH.read_text()
    if scoring.README_START not in text:
        logger.warning(
            "No %s marker in %s — skipping the README summary.",
            scoring.README_START,
            _README_PATH.name,
        )
        return

    head, _, rest = text.partition(scoring.README_START)
    tail = rest.partition(scoring.README_END)[2] if scoring.README_END in rest else rest
    _README_PATH.write_text(head + scoring.render_readme_summary(summary) + tail)
    logger.info("Wrote the accuracy block in %s", _README_PATH.name)


def latest_artifact_path() -> Path | None:
    paths = sorted(_RESULTS_DIR.glob("*.json")) if _RESULTS_DIR.exists() else []
    return paths[-1] if paths else None


async def score(
    results: Path | None, baseline: Path | None, refresh: bool, write: bool
) -> int:
    path = results or latest_artifact_path()
    if path is None:
        logger.error("No run artifacts in %s — run the eval first.", _RESULTS_DIR)
        return 1

    path = path.resolve()  # so --results with a relative path still matches the glob
    artifact = load_artifact(path)
    scores = await score_artifact(artifact, refresh=refresh)

    # Re-score every saved run rather than keeping a separate history file:
    # the history then always reflects the current rules, and can't drift.
    history: list[scoring.RunSummary] = []
    for other in sorted(p.resolve() for p in _RESULTS_DIR.glob("*.json")):
        past = artifact if other == path else load_artifact(other)
        past_scores = scores if other == path else await score_artifact(past, refresh=False)
        history.append(scoring.summarize(past, past_scores))

    baseline_summary = None
    if baseline is not None:
        base_artifact = load_artifact(baseline)
        base_scores = await score_artifact(base_artifact, refresh=False)
        baseline_summary = scoring.summarize(base_artifact, base_scores)
        for regression in scoring.regressions(scores, base_scores):
            logger.warning("REGRESSION vs baseline: %s", regression)

    report = scoring.render_markdown(artifact, scores, history, baseline_summary)
    print(report)
    if write:
        _REPORT_PATH.parent.mkdir(exist_ok=True)
        _REPORT_PATH.write_text(report)
        logger.info("Wrote %s", _REPORT_PATH)
        _write_readme_summary(scoring.summarize(artifact, scores))

    result = scoring.totals(scores)
    return 0 if result.scored else 1


# --- CLI ---

async def _dispatch(args: argparse.Namespace) -> int:
    """No app lifespan here, so the shared EDGAR client is closed by hand."""
    try:
        if args.command == "build-golden":
            return await build_golden([t.upper() for t in args.tickers])

        if args.command == "run":
            code, path = await run(
                ticker=args.ticker.upper() if args.ticker else None,
                limit=args.limit,
                sleep=args.sleep,
                tag=args.tag,
                allow_fallback=args.allow_fallback,
                resume=args.resume,
                resume_from=Path(args.resume_from) if args.resume_from else None,
            )
            if path is not None and not args.no_score:
                await score(
                    results=path,
                    baseline=Path(args.baseline) if args.baseline else None,
                    refresh=args.refresh_xbrl,
                    write=True,
                )
            return code

        return await score(
            results=Path(args.results) if args.results else None,
            baseline=Path(args.baseline) if args.baseline else None,
            refresh=args.refresh_xbrl,
            write=not args.no_write,
        )
    finally:
        await edgar.close_client()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build-golden", help="Resolve tickers to 10-Ks (EDGAR only, no quota)")
    build.add_argument("tickers", nargs="+", help="Tickers to include in the golden set")

    run_cmd = sub.add_parser("run", help="Fetch + extract (SPENDS Gemini quota), then score")
    run_cmd.add_argument("--ticker", help="Only this ticker")
    run_cmd.add_argument("--limit", type=int, help="Stop after N filings")
    run_cmd.add_argument(
        "--sleep",
        type=float,
        default=_DEFAULT_SLEEP,
        help=f"Seconds between filings, for free-tier RPM (default {_DEFAULT_SLEEP:g})",
    )
    run_cmd.add_argument("--tag", help="Suffix the artifact filename to keep same-day runs apart")
    run_cmd.add_argument(
        "--resume",
        action="store_true",
        help="Reuse successful extractions from today's artifact instead of re-spending quota",
    )
    run_cmd.add_argument(
        "--resume-from",
        help="Resume from a specific artifact (implies --resume)",
    )
    run_cmd.add_argument(
        "--allow-fallback",
        action="store_true",
        help="Permit GEMINI_FALLBACK_MODEL on quota errors (mixes models in one report)",
    )
    run_cmd.add_argument("--no-score", action="store_true", help="Write the artifact only")
    run_cmd.add_argument("--baseline", help="Artifact to compare the new run against")
    run_cmd.add_argument("--refresh-xbrl", action="store_true", help="Re-pull cached ground truth")

    score_cmd = sub.add_parser("score", help="Score a saved run against XBRL (free)")
    score_cmd.add_argument("--results", help="Artifact to score (default: newest)")
    score_cmd.add_argument("--baseline", help="Artifact to compare against")
    score_cmd.add_argument("--refresh-xbrl", action="store_true", help="Re-pull cached ground truth")
    score_cmd.add_argument("--no-write", action="store_true", help="Print without writing docs/evals.md")

    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    try:
        return asyncio.run(_dispatch(args))
    except KeyboardInterrupt:
        logger.warning("Interrupted — anything already written is kept.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
