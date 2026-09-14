"""Pure comparison + report rendering for the Q&A eval (roadmap 11.2).
Split out from eval_qa.py so the metrics run under normal pytest — no network, no Gemini key, no corpus, no quota spent."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel

from evals.scoring import TOLERANCE, within_tolerance


# How close a derived figure must sit to a ratio or difference of two grounded ones
# before it counts as arithmetic rather than invention. Looser than TOLERANCE because
# the model rounds its own percentages ("up about 6%") far harder than it rounds a
# quoted figure.
COMPUTED_TOLERANCE = 0.02

# A shingle long enough that sharing one with a chunk means the answer drew on it,
# not that both are English. Measured in words.
_SHINGLE_WORDS = 8

Support = Literal["verbatim", "computed", "unsupported"]

# What the model says when it declines. The Q&A system prompt tells it to say the
# narrative sections "don't state" a figure, so that phrasing leads; the rest are the
# neighbouring forms it reaches for. Recorded in every artifact: a model that starts
# refusing in new words would otherwise read as a regression in refusal rate.
REFUSAL_MARKERS = [
    "do not state",
    "does not state",
    "don't state",
    "doesn't state",
    "not stated",
    "not disclosed",
    "does not disclose",
    "do not disclose",
    "no information",
    "not provided",
    "does not provide",
    "does not contain",
    "do not contain",
    "does not mention",
    "do not mention",
    "does not specify",
    "do not specify",
    "cannot be determined",
    "unable to determine",
    "not available in",
]

_SCALE_WORDS: dict[str, float] = {
    "thousand": 1e3,
    "million": 1e6,
    "billion": 1e9,
    "trillion": 1e12,
}

# Optional $, a number with either grouped thousands or a plain decimal, then an
# optional scale word or percent sign. Deliberately not matching bare years: a
# four-digit integer is caught, and FY labels are excluded by _YEAR_RE below.
_NUMBER_RE = re.compile(
    r"\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*"
    r"(thousand|million|billion|trillion|percent|%)?",
    re.I,
)
# 1900-2099 standing alone is a fiscal year, not a financial claim.
_YEAR_RE = re.compile(r"^(19|20)\d{2}$")

_WORD_RE = re.compile(r"[a-z0-9]+")

# The Q&A prompt asks the model to cite its sources as "(excerpt 2)", so every answer
# carries numerals that are not claims about the filing. Stripped before figures are
# extracted, or each citation would score as an invented figure.
_CITATION_RE = re.compile(r"\(?\s*excerpts?\s+[\d\s,and&-]+\)?", re.I)


# --- data carried between `run` and `score` ---

class GoldenQuestion(BaseModel):
    """One labeled question in the Q&A golden set."""

    accession_number: str
    ticker: str
    question: str
    kind: Literal["answerable", "unanswerable"] = "answerable"
    # The retrieval label: a distinctive phrase that must appear in a retrieved chunk.
    # Only answerable questions carry one.
    expect_substring: str = ""


class RetrievedChunk(BaseModel):
    """One chunk the retriever returned, with the full text the model actually saw.
    Not `AskSource.excerpt`: the endpoint truncates that to 300 chars for display, and scoring against the truncation would call a correctly grounded figure unsupported."""

    chunk_index: int
    similarity: float
    content: str


class QARecord(BaseModel):
    """What `run` produced for one question."""

    accession_number: str
    ticker: str
    question: str
    kind: Literal["answerable", "unanswerable"] = "answerable"
    expect_substring: str = ""
    answer: str = ""
    unit_scale: str | None = None
    chunks: list[RetrievedChunk] = []
    error: str | None = None


class QAArtifact(BaseModel):
    """A complete `run`, persisted so scoring never needs the corpus or any quota."""

    run_date: str
    model: str
    fallback_model: str = ""
    retrieval_k: int
    chunk_size: int
    refusal_markers: list[str] = []
    records: list[QARecord] = []


class Figure(BaseModel):
    """One numeric literal lifted out of prose."""

    raw: str
    value: float
    is_percent: bool = False
    # Every magnitude this literal could denote. "11,133" under a millions scale could
    # be 11,133 or 11.133 billion, and the filing may print either.
    candidates: list[float] = []


class FigureScore(BaseModel):
    raw: str
    support: Support
    # Carried through so citation precision can ask which chunk actually prints this
    # figure: the answer renders it "$416,161 million" where the chunk prints "416,161".
    candidates: list[float] = []


class AnswerScore(BaseModel):
    ticker: str
    question: str
    kind: Literal["answerable", "unanswerable"]
    figures: list[FigureScore] = []
    refused: bool = False
    # None for unanswerable questions, which carry no retrieval label.
    hit_at_1: bool | None = None
    hit_at_k: bool | None = None
    sources_used: int = 0
    sources_total: int = 0
    error: str | None = None

    @property
    def unsupported(self) -> list[str]:
        return [f.raw for f in self.figures if f.support == "unsupported"]

    @property
    def computed(self) -> list[str]:
        return [f.raw for f in self.figures if f.support == "computed"]

    @property
    def grounded(self) -> bool:
        """No invented figures. An answer with no figures at all is grounded — it made no numeric claim to get wrong."""
        return self.error is None and not self.unsupported


class QATotals(BaseModel):
    answerable: int = 0
    unanswerable: int = 0
    grounded: int = 0
    refused: int = 0
    hits_at_1: int = 0
    hits_at_k: int = 0
    computed_figures: int = 0
    unsupported_figures: int = 0
    sources_used: int = 0
    sources_total: int = 0
    answerable_sources_used: int = 0
    answerable_sources_total: int = 0
    errors: int = 0

    @property
    def grounded_rate(self) -> float | None:
        return self.grounded / self.answerable if self.answerable else None

    @property
    def refusal_rate(self) -> float | None:
        return self.refused / self.unanswerable if self.unanswerable else None

    @property
    def hit_rate_at_1(self) -> float | None:
        return self.hits_at_1 / self.answerable if self.answerable else None

    @property
    def hit_rate_at_k(self) -> float | None:
        return self.hits_at_k / self.answerable if self.answerable else None

    @property
    def citation_precision(self) -> float | None:
        """Answerable questions only. On an unanswerable one the model *should* draw on
        nothing, so counting its six unused excerpts as misses penalises the right answer.

        Known limitation: a source counts as used only via a quoted figure or a shared
        8-gram, so an answer that paraphrases its source scores zero. This measures how
        much an answer quotes at least as much as how many sources it used, and is not
        yet a sound basis for tuning _RETRIEVAL_K."""
        return (
            self.answerable_sources_used / self.answerable_sources_total
            if self.answerable_sources_total
            else None
        )


# --- figure extraction and normalization ---

def _scale_multiplier(unit_scale: str | None) -> float | None:
    """The factor a filing's "(in millions)" header applies to its bare figures."""
    if not unit_scale:
        return None
    lowered = unit_scale.lower()
    for word, factor in _SCALE_WORDS.items():
        if word in lowered:
            return factor
    return None


def extract_figures(text: str, unit_scale: str | None = None) -> list[Figure]:
    """Every numeric literal in `text`, each carrying the magnitudes it could denote.
    A literal with its own scale word ("11.1 billion") could be either the written number or the expansion, since filings print both; one without picks up the filing's declared scale instead."""
    figures: list[Figure] = []
    multiplier = _scale_multiplier(unit_scale)

    for match in _NUMBER_RE.finditer(text):
        digits, suffix = match.group(1), (match.group(2) or "").lower()
        if _YEAR_RE.match(digits):
            continue
        try:
            base = float(digits.replace(",", ""))
        except ValueError:  # pragma: no cover - the regex cannot produce this
            continue

        is_percent = suffix in ("%", "percent")
        candidates = [base]
        if suffix in _SCALE_WORDS:
            candidates.append(base * _SCALE_WORDS[suffix])
        elif not is_percent and multiplier is not None:
            candidates.append(base * multiplier)

        figures.append(
            Figure(
                raw=match.group(0).strip(),
                value=base,
                is_percent=is_percent,
                candidates=candidates,
            )
        )
    return figures


def _matches(candidates: list[float], corpus: list[Figure]) -> bool:
    """Does any figure in the retrieved text denote one of these magnitudes?
    Both sides carry candidate lists, so "$11,133 million" in the answer matches a chunk printing "11,133" under a millions header, and the reverse.

    Known limitation: small integers ("3 segments") match something in almost any filing by coincidence, so the metric's real signal is the large distinctive figures. They are still scored, because skipping them would equally excuse an invented small count."""
    for value in candidates:
        for other in corpus:
            for truth in other.candidates:
                if truth == 0:
                    if value == 0:
                        return True
                    continue
                if within_tolerance(value, truth):
                    return True
    return False


def _computed_values(verbatim: list[Figure]) -> list[float]:
    """Everything derivable from two grounded figures by one arithmetic step.
    A YoY percentage or a segment total is the model doing its job, not inventing; it is counted apart from `verbatim` so a hallucinated percentage cannot hide among them."""
    values: list[float] = []
    magnitudes = [c for f in verbatim for c in f.candidates]
    for i, a in enumerate(magnitudes):
        for j, b in enumerate(magnitudes):
            # Pairing a figure with itself yields 0, 1 and 100 whatever the figures are,
            # which would quietly excuse an invented "1 million" as arithmetic.
            if i == j:
                continue
            values.append(a - b)
            values.append(a + b)
            if b != 0:
                ratio = a / b
                values.append(ratio)
                values.append(ratio * 100)
                values.append((a - b) / b * 100)
    return values


def classify_figures(
    answer: str, chunks: list[RetrievedChunk], question: str, unit_scale: str | None
) -> list[FigureScore]:
    """Score every figure in the answer against the text the model was given.
    Figures that also appear in the question are dropped entirely — echoing the asker is not a claim about the filing."""
    corpus_text = "\n\n".join(chunk.content for chunk in chunks)
    corpus = extract_figures(corpus_text, unit_scale)
    asked = extract_figures(question, unit_scale)
    answer = _CITATION_RE.sub(" ", answer)

    scores: list[FigureScore] = []
    verbatim: list[Figure] = []
    pending: list[tuple[int, Figure]] = []

    for figure in extract_figures(answer, unit_scale):
        if _matches(figure.candidates, asked):
            continue
        if _matches(figure.candidates, corpus):
            verbatim.append(figure)
            scores.append(
                FigureScore(raw=figure.raw, support="verbatim", candidates=figure.candidates)
            )
        else:
            pending.append((len(scores), figure))
            scores.append(
                FigureScore(raw=figure.raw, support="unsupported", candidates=figure.candidates)
            )

    # Second pass: arithmetic needs the complete set of grounded figures, so it cannot
    # be decided while that set is still being built.
    if pending and verbatim:
        derivable = _computed_values(verbatim)
        for position, figure in pending:
            if any(
                within_tolerance(figure.value, value, COMPUTED_TOLERANCE)
                for value in derivable
            ):
                scores[position].support = "computed"
    return scores


# --- per-answer scoring ---

def is_refusal(answer: str, markers: list[str] | None = None) -> bool:
    """Did the model decline rather than answer?
    Phrase matching, because the alternative is asking a model whether a model refused."""
    lowered = answer.lower()
    return any(marker in lowered for marker in (markers or REFUSAL_MARKERS))


def flatten(text: str) -> str:
    """Whitespace- and case-insensitive form, for matching a label against filing prose.
    EDGAR text keeps the source document's line breaks and non-breaking spaces (452 in one filing in this set), so a label typed with ordinary spaces would otherwise miss the very sentence it quotes."""
    return " ".join(text.split()).lower()


def _shingles(text: str, size: int = _SHINGLE_WORDS) -> set[str]:
    words = _WORD_RE.findall(text.lower())
    if len(words) < size:
        return set()
    return {" ".join(words[i : i + size]) for i in range(len(words) - size + 1)}


def _source_used(
    chunk: RetrievedChunk,
    answer: str,
    verbatim: list[FigureScore],
    unit_scale: str | None,
) -> bool:
    """Did the answer actually draw on this chunk?
    A figure this chunk prints, or a shared 8-gram; citation markers like "(excerpt 2)" are ignored, because a claimed citation is exactly what is being measured."""
    printed = extract_figures(chunk.content, unit_scale)
    if any(_matches(figure.candidates, printed) for figure in verbatim):
        return True
    return bool(_shingles(answer) & _shingles(chunk.content))


def score_record(
    record: QARecord, markers: list[str] | None = None
) -> AnswerScore:
    if record.error:
        return AnswerScore(
            ticker=record.ticker,
            question=record.question,
            kind=record.kind,
            error=record.error,
            sources_total=len(record.chunks),
        )

    figures = classify_figures(
        record.answer, record.chunks, record.question, record.unit_scale
    )
    verbatim = [f for f in figures if f.support == "verbatim"]
    refused = is_refusal(record.answer, markers)

    hit_at_1: bool | None = None
    hit_at_k: bool | None = None
    if record.kind == "answerable" and record.expect_substring:
        needle = flatten(record.expect_substring)
        hit_at_1 = bool(record.chunks) and needle in flatten(record.chunks[0].content)
        hit_at_k = any(needle in flatten(c.content) for c in record.chunks)

    return AnswerScore(
        ticker=record.ticker,
        question=record.question,
        kind=record.kind,
        figures=figures,
        refused=refused,
        hit_at_1=hit_at_1,
        hit_at_k=hit_at_k,
        sources_used=sum(
            _source_used(c, record.answer, verbatim, record.unit_scale)
            for c in record.chunks
        ),
        sources_total=len(record.chunks),
    )


def totals(scores: list[AnswerScore]) -> QATotals:
    result = QATotals()
    for score in scores:
        if score.error:
            result.errors += 1
        if score.kind == "answerable":
            result.answerable += 1
            result.answerable_sources_used += score.sources_used
            result.answerable_sources_total += score.sources_total
            if score.error is None and score.grounded:
                result.grounded += 1
            if score.hit_at_1:
                result.hits_at_1 += 1
            if score.hit_at_k:
                result.hits_at_k += 1
        else:
            result.unanswerable += 1
            # A refusal only counts if the model also invented nothing while declining.
            if score.error is None and score.refused and score.grounded:
                result.refused += 1
        result.computed_figures += len(score.computed)
        result.unsupported_figures += len(score.unsupported)
        result.sources_used += score.sources_used
        result.sources_total += score.sources_total
    return result


# --- regressions ---

def regressions(current: list[AnswerScore], baseline: list[AnswerScore]) -> list[str]:
    """Questions that got worse between two runs, one line each.
    Keyed on the question text: reordering the golden set must not read as a regression."""
    before = {score.question: score for score in baseline}
    found: list[str] = []

    for score in current:
        old = before.get(score.question)
        if old is None:
            continue
        label = f"{score.ticker}: {score.question[:60]}"
        if old.error is None and score.error is not None:
            found.append(f"{label} — now errors: {score.error}")
            continue
        if old.grounded and not score.grounded:
            found.append(f"{label} — grounded, now invents {', '.join(score.unsupported)}")
        if old.kind == "unanswerable" and old.refused and not score.refused:
            found.append(f"{label} — refused, now answers")
        if old.hit_at_k and not score.hit_at_k:
            found.append(f"{label} — retrieval no longer finds the expected text")
    return found


# --- rendering ---

class QASummary(BaseModel):
    """One line of the run-history table."""

    run_date: str
    model: str
    retrieval_k: int
    questions: int
    grounded_rate: float | None
    refusal_rate: float | None
    hit_rate_at_k: float | None
    citation_precision: float | None


def summarize(artifact: QAArtifact, scores: list[AnswerScore]) -> QASummary:
    result = totals(scores)
    return QASummary(
        run_date=artifact.run_date,
        model=artifact.model,
        retrieval_k=artifact.retrieval_k,
        questions=len(artifact.records),
        grounded_rate=result.grounded_rate,
        refusal_rate=result.refusal_rate,
        hit_rate_at_k=result.hit_rate_at_k,
        citation_precision=result.citation_precision,
    )


def _pct(value: float | None) -> str:
    return f"{value * 100:.1f}%" if value is not None else "n/a"


# The README's generated block. Fenced by markers so a re-score replaces it in
# place instead of appending a second table.
README_START = "<!-- GROUNDEDNESS_TABLE -->"
README_END = "<!-- /GROUNDEDNESS_TABLE -->"


def render_readme_summary(summary: QASummary) -> str:
    """Headline figures only, for the README's generated groundedness block — `docs/` is gitignored, so this is the only place a public reader can see the numbers.
    Generated, never hand-written; no dashes in the output, which the README forbids."""
    return "\n".join(
        [
            README_START,
            "",
            "| Run | Model | Questions | Grounded | Refused | Retrieval hit @6 |",
            "|---|---|---|---|---|---|",
            f"| {summary.run_date} | `{summary.model}` | {summary.questions} "
            f"| {_pct(summary.grounded_rate)} | {_pct(summary.refusal_rate)} "
            f"| {_pct(summary.hit_rate_at_k)} |",
            "",
            README_END,
        ]
    )


_PREAMBLE = """# Q&A groundedness

Scores what the Q&A path *says* against the excerpts it was actually given —
the one claim the extraction eval cannot make, because a wrong figure in a
paragraph of prose looks exactly like a right one.

Method: for each question in `backend/evals/qa_golden.json`, the real retrieval
pipeline runs (`embed_texts` → nearest chunks by cosine → `llm.answer_question`,
unit-scale resolution included) against a locally built corpus of the same
filings the extraction eval uses. Every numeric literal in the answer is then
checked against the retrieved text. A figure is `verbatim` when the excerpts
contain it, `computed` when it is one arithmetic step from two verbatim figures
(a YoY percentage is the model doing its job), and `unsupported` otherwise.
Figures echoed from the question are excluded.

Four metrics: **grounded rate** (answerable questions with no unsupported
figure), **refusal rate** (unanswerable questions the model declines instead of
inventing), **retrieval hit rate** (the labelled phrase appears in a retrieved
chunk) and **citation precision** (how many of the six returned sources the
answer drew on).

Reproduce with `cd backend && python -m evals.eval_qa run`. It spends real
Gemini quota and needs a corpus built by `build-corpus`, so it never runs on a
push: CI re-scores the saved runs instead, which needs neither.
"""


def render_markdown(
    artifact: QAArtifact,
    scores: list[AnswerScore],
    history: list[QASummary],
    baseline: QASummary | None = None,
) -> str:
    result = totals(scores)
    lines = [_PREAMBLE]

    lines.append(
        f"## Latest run — {artifact.run_date} · `{artifact.model}` · "
        f"K={artifact.retrieval_k} · CHUNK_SIZE={artifact.chunk_size:,}"
    )
    lines.append("")
    if not artifact.fallback_model:
        lines.append(
            "_Model fallback disabled for this run, so every row below was served "
            "by the model named above._"
        )
        lines.append("")

    lines.append("| Ticker | Kind | Question | Grounded | Hit @1 | Hit @6 | Sources used | Notes |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for score in scores:
        lines.append(
            f"| {score.ticker} | {score.kind} | {score.question[:70]} "
            f"| {_verdict(score)} | {_flag(score.hit_at_1)} | {_flag(score.hit_at_k)} "
            f"| {score.sources_used}/{score.sources_total} | {_notes(score)} |"
        )
    lines.append("")

    lines.append(
        f"**Grounded: {result.grounded}/{result.answerable} "
        f"({_pct(result.grounded_rate)})** · "
        f"**Refused: {result.refused}/{result.unanswerable} "
        f"({_pct(result.refusal_rate)})**"
    )
    lines.append("")
    lines.append(
        f"Retrieval hit rate: {_pct(result.hit_rate_at_1)} @1, "
        f"{_pct(result.hit_rate_at_k)} @{artifact.retrieval_k} · "
        f"Citation precision: {_pct(result.citation_precision)} "
        f"({result.answerable_sources_used}/{result.answerable_sources_total} "
        f"sources drawn on, answerable only) · "
        f"{result.computed_figures} computed figure(s), "
        f"{result.unsupported_figures} unsupported"
    )
    lines.append("")

    if baseline is not None:
        lines.append(_delta_line(baseline, result.grounded_rate))
        lines.append("")

    lines.append("## Run history")
    lines.append("")
    lines.append("| Date | Model | K | Questions | Grounded | Refused | Hit @K | Citation |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for run in sorted(history, key=lambda r: r.run_date, reverse=True):
        lines.append(
            f"| {run.run_date} | `{run.model}` | {run.retrieval_k} | {run.questions} "
            f"| {_pct(run.grounded_rate)} | {_pct(run.refusal_rate)} "
            f"| {_pct(run.hit_rate_at_k)} | {_pct(run.citation_precision)} |"
        )
    lines.append("")
    lines.append(
        "_Every row is re-scored from its saved artifact under "
        "`backend/evals/qa_results/` on each `score`, so the whole history always "
        "reflects the current scoring rules._"
    )
    lines.append("")
    return "\n".join(lines)


def _flag(value: bool | None) -> str:
    return "—" if value is None else ("✓" if value else "✗")


def _verdict(score: AnswerScore) -> str:
    if score.error:
        return "!"
    if score.kind == "unanswerable":
        return "✓" if (score.refused and score.grounded) else "✗"
    return "✓" if score.grounded else "✗"


def _notes(score: AnswerScore) -> str:
    if score.error:
        return f"run failed: {score.error}"
    parts: list[str] = []
    if score.unsupported:
        parts.append(f"unsupported: {', '.join(score.unsupported)}")
    if score.computed:
        parts.append(f"computed: {', '.join(score.computed)}")
    if score.kind == "unanswerable" and not score.refused:
        parts.append("did not decline")
    return "; ".join(parts)


def _delta_line(baseline: QASummary, grounded_rate: float | None) -> str:
    if grounded_rate is None or baseline.grounded_rate is None:
        return f"Δ vs baseline ({baseline.run_date}): not comparable."
    delta = (grounded_rate - baseline.grounded_rate) * 100
    direction = "no change" if abs(delta) < 0.05 else f"{delta:+.1f} pts"
    return (
        f"**Δ vs baseline** ({baseline.run_date}, `{baseline.model}`, "
        f"K={baseline.retrieval_k}): {direction} "
        f"({_pct(baseline.grounded_rate)} → {_pct(grounded_rate)})"
    )
