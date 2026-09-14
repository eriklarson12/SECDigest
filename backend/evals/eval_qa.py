"""Score the retrieval-augmented Q&A path for groundedness, retrieval quality and refusal: `build-corpus`/`check-golden`/`run`/`score` via `python -m evals.eval_qa`.
Lives outside `tests/` because `build-corpus` and `run` spend real Gemini quota; `score` is free, needs neither the corpus nor the network, and gates CI via `score --gate`."""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import logging
import math
import sys
from pathlib import Path

from pydantic import BaseModel

from app.config import settings
from app.routers.analysis import _RETRIEVAL_K
from app.services import edgar, embeddings, units
from app.services.embeddings import CHUNK_OVERLAP, CHUNK_SIZE, TokenPacer, chunk_text
from app.services.llm import LLMError, LLMOverloadedError, LLMQuotaError, answer_question
from evals import qa_scoring
from evals.eval_extraction import load_golden
from evals.qa_scoring import (
    AnswerScore,
    GoldenQuestion,
    QAArtifact,
    QARecord,
    RetrievedChunk,
)

logger = logging.getLogger("evals")

_HERE = Path(__file__).parent
_GOLDEN_PATH = _HERE / "qa_golden.json"
# Gitignored, unlike evals/ground_truth.json. The extraction pin is a scoring *input*, so CI
# needs it; the corpus is only a `run` input, and the artifact carries every chunk the model
# actually saw. Committing ~7 MB of float vectors the gate never reads would buy nothing.
_CORPUS_DIR = _HERE / "qa_corpus"
_RESULTS_DIR = _HERE / "qa_results"
# Shared with the extraction gate: one committed file holds every floor, so lowering
# any bar shows up in the same code review.
_GATE_PATH = _HERE / "gate.json"
_REPORT_PATH = _HERE.parent.parent / "docs" / "evals-qa.md"
# The public half of the report: `docs/` is gitignored, README.md is not.
_README_PATH = _HERE.parent.parent / "README.md"

# Questions are two orders of magnitude smaller than filings, so TPM never binds here;
# this only keeps the request rate under free-tier RPM.
_DEFAULT_SLEEP = 4.0

_OVERLOAD_ATTEMPTS = 3
_OVERLOAD_BACKOFF = 30.0

# What database._SCALE_FILTER prefilters on, as a local predicate. Same three phrases,
# because units.extract_scale decides which of them is a real declaration.
_SCALE_HINTS = ("in millions", "in thousands", "in billions")


class CorpusChunk(BaseModel):
    chunk_index: int
    content: str
    embedding: list[float]


class FilingCorpus(BaseModel):
    """One filing chunked and embedded, standing in for its `filing_chunks` rows.
    The chunking parameters are recorded so a corpus built under a different CHUNK_SIZE is caught rather than silently scored."""

    accession_number: str
    ticker: str
    chunk_size: int
    chunk_overlap: int
    embed_model: str
    # What the filing chunks to. `chunks` falls short of it when a build stopped partway,
    # which is the difference between "resume this" and "this is ready to run against".
    total_chunks: int = 0
    chunks: list[CorpusChunk] = []

    @property
    def complete(self) -> bool:
        return len(self.chunks) >= self.total_chunks


# --- golden set ---

def load_questions() -> list[GoldenQuestion]:
    return [GoldenQuestion.model_validate(e) for e in json.loads(_GOLDEN_PATH.read_text())]


def numbered(base: int, batch: list[str], vectors: list[list[float]]) -> list[CorpusChunk]:
    """Label one embedded batch with its document positions.
    `base` is read once, before anything is appended: computing it inside a generator passed to list.extend drifts, because the list grows under the generator as it is consumed."""
    return [
        CorpusChunk(chunk_index=base + i, content=c, embedding=v)
        for i, (c, v) in enumerate(zip(batch, vectors))
    ]


def _corpus_path(accession_number: str) -> Path:
    return _CORPUS_DIR / f"{accession_number}.json"


def load_corpus(accession_number: str) -> FilingCorpus:
    path = _corpus_path(accession_number)
    if not path.exists():
        raise FileNotFoundError(
            f"No corpus for {accession_number} — run `python -m evals.eval_qa build-corpus` first."
        )
    corpus = FilingCorpus.model_validate_json(path.read_text())
    if not corpus.complete:
        raise ValueError(
            f"{path.name} holds {len(corpus.chunks)} of {corpus.total_chunks} chunks — "
            "re-run `build-corpus` to top it up before scoring against it."
        )
    if corpus.chunk_size != CHUNK_SIZE or corpus.chunk_overlap != CHUNK_OVERLAP:
        raise ValueError(
            f"{path.name} was built at chunk_size={corpus.chunk_size}/"
            f"overlap={corpus.chunk_overlap}, but the app now uses "
            f"{CHUNK_SIZE}/{CHUNK_OVERLAP} — rebuild with --refresh."
        )
    return corpus


# --- corpus (SPENDS embedding quota) ---

async def build_corpus(tickers: list[str] | None, refresh: bool) -> int:
    """Chunk and embed every filing the question set asks about, once.
    Goes through embeddings.embed_texts, so it reserves against the same daily budget the live site draws on: an overrun stops the build instead of silently stranding production indexing for the rest of the day."""
    questions = load_questions()
    wanted = {q.accession_number for q in questions}
    entries = {e.accession_number: e for e in load_golden() if e.accession_number in wanted}

    missing = wanted - set(entries)
    if missing:
        logger.error("Questions name filings absent from golden.json: %s", ", ".join(sorted(missing)))
        return 1
    if tickers:
        entries = {a: e for a, e in entries.items() if e.ticker in tickers}
    if not entries:
        logger.error("No filings selected.")
        return 1

    _CORPUS_DIR.mkdir(exist_ok=True)
    pacer = TokenPacer()
    built = 0

    for entry in entries.values():
        path = _corpus_path(entry.accession_number)
        done: list[CorpusChunk] = []
        if path.exists():
            existing = FilingCorpus.model_validate_json(path.read_text())
            if existing.complete and not refresh:
                logger.info("%s — corpus already built, skipping", entry.ticker)
                continue
            if not refresh:
                done = existing.chunks
                logger.info(
                    "%s — resuming from %d embedded chunk(s)", entry.ticker, len(done)
                )

        logger.info("%s — fetching filing", entry.ticker)
        text = await edgar.fetch_filing_text(
            entry.cik, entry.accession_number, entry.primary_document
        )
        chunks = chunk_text(text)
        remaining = chunks[len(done) :]
        logger.info(
            "%s — %d chars, %d chunks, %d to embed",
            entry.ticker, len(text), len(chunks), len(remaining),
        )

        def save() -> None:
            path.write_text(
                FilingCorpus(
                    accession_number=entry.accession_number,
                    ticker=entry.ticker,
                    chunk_size=CHUNK_SIZE,
                    chunk_overlap=CHUNK_OVERLAP,
                    embed_model=settings.gemini_embed_model,
                    total_chunks=len(chunks),
                    chunks=done,
                ).model_dump_json()
            )

        # Embed a batch at a time and persist after each. embed_texts would do the whole
        # filing in one call, but it raises on a refused reservation and every vector it
        # already paid for is lost with it — which is exactly what a transient Supabase
        # Gateway Timeout cost on the first build.
        for batch in embeddings.plan_batches(remaining):
            try:
                vectors = await embeddings.embed_texts(
                    batch, embeddings.DOCUMENT_TASK, pacer=pacer
                )
            except embeddings.EmbeddingRequestQuotaError:
                save()
                # Either the day's budget really is gone or the quota table is unreachable;
                # try_consume_embeddings fails closed and cannot tell us which. Both mean stop.
                logger.error(
                    "%s — embedding reservation refused at %d/%d chunks (daily budget spent, "
                    "or the quota table is unreachable). Progress saved; re-run to resume.",
                    entry.ticker, len(done), len(chunks),
                )
                return 1
            done.extend(numbered(len(done), batch, vectors))
            save()

        built += 1
        logger.info("%s — %d chunks in %s", entry.ticker, len(done), path.name)

    logger.info("Corpus complete: %d filing(s) built this run.", built)
    return 0


def check_golden() -> int:
    """Assert every retrieval label actually occurs in its filing.
    A typo'd `expect_substring` would otherwise read as a retrieval miss forever, blaming the retriever for a bad label."""
    problems: list[str] = []
    corpora: dict[str, FilingCorpus] = {}

    for question in load_questions():
        if question.kind == "unanswerable":
            if question.expect_substring:
                problems.append(f"{question.ticker}: unanswerable question carries a retrieval label")
            continue
        if not question.expect_substring:
            problems.append(f"{question.ticker}: answerable question has no expect_substring")
            continue

        if question.accession_number not in corpora:
            corpora[question.accession_number] = load_corpus(question.accession_number)
        corpus = corpora[question.accession_number]
        needle = qa_scoring.flatten(question.expect_substring)
        if not any(needle in qa_scoring.flatten(c.content) for c in corpus.chunks):
            problems.append(
                f"{question.ticker}: {question.expect_substring!r} is in no chunk of {question.accession_number}"
            )

    for problem in problems:
        logger.error("%s", problem)
    if problems:
        logger.error("%d bad label(s).", len(problems))
        return 2
    logger.info("All retrieval labels present in the corpus.")
    return 0


# --- retrieval (free, local) ---

def cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity, matching what pgvector's `<=>` computes.
    Magnitudes must divide out: the stored vectors are MRL-truncated to 768 dims and never re-normalized, so a bare dot product would rank by length as much as by direction."""
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


def top_chunks(corpus: FilingCorpus, query: list[float], k: int) -> list[RetrievedChunk]:
    """The k nearest chunks, standing in for database.match_chunks."""
    ranked = sorted(
        (
            RetrievedChunk(
                chunk_index=chunk.chunk_index,
                similarity=cosine(query, chunk.embedding),
                content=chunk.content,
            )
            for chunk in corpus.chunks
        ),
        key=lambda c: c.similarity,
        reverse=True,
    )
    return ranked[:k]


def scale_for(corpus: FilingCorpus, near_chunk_index: int) -> str | None:
    """The unit scale governing a chunk, standing in for units.scale_for.
    Same rule as database.find_scale_chunks — nearest declaring chunk at or before the target, falling back to the filing's first — then the real units.extract_scale decides which candidate is a declaration."""
    declaring = [c for c in corpus.chunks if any(h in c.content.lower() for h in _SCALE_HINTS)]
    nearest = sorted(
        (c for c in declaring if c.chunk_index <= near_chunk_index),
        key=lambda c: c.chunk_index,
        reverse=True,
    )[: units._CANDIDATES]
    if not nearest:
        nearest = sorted(declaring, key=lambda c: c.chunk_index)[: units._CANDIDATES]

    for chunk in nearest:
        scale = units.extract_scale(chunk.content)
        if scale:
            return scale
    return None


# --- run (SPENDS quota) ---

async def _answer_with_overload_retry(
    question: str, contents: list[str], unit_scale: str | None, label: str
) -> str:
    delay = _OVERLOAD_BACKOFF
    for attempt in range(_OVERLOAD_ATTEMPTS):
        last = attempt == _OVERLOAD_ATTEMPTS - 1
        try:
            return await answer_question(question, contents, unit_scale)
        except LLMQuotaError as exc:
            # A spent daily pool has no window to wait for — let it stop the run.
            if not isinstance(exc, LLMOverloadedError) or last:
                raise
        logger.warning(
            "%s — model overloaded, retrying in %.0fs (%d/%d)",
            label, delay, attempt + 1, _OVERLOAD_ATTEMPTS - 1,
        )
        await asyncio.sleep(delay)
        delay *= 2
    raise AssertionError("unreachable")


def _artifact_path(run_date: str, tag: str | None) -> Path:
    return _RESULTS_DIR / f"{run_date}{'-' + tag if tag else ''}.json"


async def run(
    ticker: str | None,
    limit: int | None,
    sleep: float,
    tag: str | None,
    allow_fallback: bool,
) -> tuple[int, Path | None]:
    questions = load_questions()
    if ticker:
        questions = [q for q in questions if q.ticker == ticker]
    if limit is not None:
        questions = questions[:limit]
    if not questions:
        logger.error("No questions selected.")
        return 1, None

    corpora = {q.accession_number: load_corpus(q.accession_number) for q in questions}

    # One report heading has to be true of every row, so collapse the Q&A model pair to a
    # single model: _qa_models() falls back from GEMINI_QA_MODEL *up* to GEMINI_MODEL, and a
    # silent switch mid-run would put two models' answers under one name.
    primary = settings.gemini_qa_model or settings.gemini_model
    original = (settings.gemini_model, settings.gemini_fallback_model)
    if not allow_fallback:
        settings.gemini_model = primary
        settings.gemini_fallback_model = ""

    records: list[QARecord] = []
    try:
        for position, question in enumerate(questions):
            label = f"{question.ticker} · {question.question[:48]}"
            logger.info("%s", label)
            corpus = corpora[question.accession_number]

            record = QARecord(
                accession_number=question.accession_number,
                ticker=question.ticker,
                question=question.question,
                kind=question.kind,
                expect_substring=question.expect_substring,
            )
            try:
                [vector] = await embeddings.embed_texts(
                    [question.question], embeddings.QUERY_TASK
                )
                chunks = top_chunks(corpus, vector, _RETRIEVAL_K)
                unit_scale = scale_for(corpus, chunks[0].chunk_index) if chunks else None
                answer = await _answer_with_overload_retry(
                    question.question, [c.content for c in chunks], unit_scale, label
                )
                record.chunks = chunks
                record.unit_scale = unit_scale
                record.answer = answer
                logger.info("  → %s", answer.replace("\n", " ")[:120])
            except embeddings.EmbeddingRequestQuotaError:
                logger.error("Daily embedding budget spent — stopping with %d answered.", len(records))
                records.append(record.model_copy(update={"error": "embedding quota exhausted"}))
                break
            except LLMOverloadedError:
                # Unlike a spent daily pool, an overload that outlasted the backoff says
                # nothing about the next question — fail this one and keep going.
                logger.warning("%s — still overloaded after retries, skipping", label)
                record.error = "model overloaded"
            except LLMQuotaError:
                logger.error("Gemini quota exhausted — stopping with %d answered.", len(records))
                records.append(record.model_copy(update={"error": "quota exhausted"}))
                break
            except LLMError as exc:
                logger.warning("%s — failed: %s", label, exc)
                record.error = str(exc)

            records.append(record)
            if position < len(questions) - 1:
                await asyncio.sleep(sleep)
    finally:
        settings.gemini_model, settings.gemini_fallback_model = original

    artifact = QAArtifact(
        run_date=datetime.date.today().isoformat(),
        model=primary,
        fallback_model="" if not allow_fallback else settings.gemini_fallback_model,
        retrieval_k=_RETRIEVAL_K,
        chunk_size=CHUNK_SIZE,
        refusal_markers=qa_scoring.REFUSAL_MARKERS,
        records=records,
    )
    _RESULTS_DIR.mkdir(exist_ok=True)
    path = _artifact_path(artifact.run_date, tag)
    path.write_text(artifact.model_dump_json(indent=2) + "\n")
    logger.info("Wrote %d answer(s) to %s", len(records), path)
    return 0, path


# --- score (free, no corpus, no network) ---

def load_artifact(path: Path) -> QAArtifact:
    return QAArtifact.model_validate_json(path.read_text())


def score_artifact(artifact: QAArtifact) -> list[AnswerScore]:
    """Every input a metric needs is in the artifact, so this reaches nothing outside it."""
    markers = artifact.refusal_markers or qa_scoring.REFUSAL_MARKERS
    return [qa_scoring.score_record(record, markers) for record in artifact.records]


def _artifact_paths() -> list[Path]:
    return sorted(p.resolve() for p in _RESULTS_DIR.glob("*.json")) if _RESULTS_DIR.exists() else []


def latest_artifact_path() -> Path | None:
    paths = _artifact_paths()
    return paths[-1] if paths else None


def previous_artifact_path(current: Path) -> Path | None:
    """The run before `current`, which is what a regression is measured against.
    Artifacts are named by run date, so sort order is chronological; comparing the newest run to itself would report no regression ever."""
    earlier = [p for p in _artifact_paths() if p.name < current.name]
    return earlier[-1] if earlier else None


def load_gate() -> tuple[float | None, float | None]:
    """The grounded and refusal floors, from the committed gate.json."""
    if not _GATE_PATH.exists():
        return None, None
    data = json.loads(_GATE_PATH.read_text())
    return data.get("qa_min_grounded_rate"), data.get("qa_min_refusal_rate")


def _write_readme_summary(summary: qa_scoring.QASummary) -> None:
    """Replace the README's generated groundedness block in place.
    An absent start marker is not an error: someone may have removed the block deliberately, and a score run shouldn't put it back."""
    if not _README_PATH.exists():
        return
    text = _README_PATH.read_text()
    if qa_scoring.README_START not in text:
        logger.warning(
            "No %s marker in %s — skipping the README summary.",
            qa_scoring.README_START,
            _README_PATH.name,
        )
        return
    head, _, rest = text.partition(qa_scoring.README_START)
    tail = rest.partition(qa_scoring.README_END)[2] if qa_scoring.README_END in rest else rest
    _README_PATH.write_text(head + qa_scoring.render_readme_summary(summary) + tail)
    logger.info("Wrote the groundedness block in %s", _README_PATH.name)


def _check_floor(
    name: str, value: float | None, floor: float | None, failures: list[str]
) -> None:
    if floor is None:
        return
    if value is None or value < floor:
        logger.error(
            "GATE: %s %.1f%% is below the floor of %.1f%%",
            name, (value or 0.0) * 100, floor * 100,
        )
        failures.append(f"{name} below the floor")


def score(
    results: Path | None,
    baseline: Path | None,
    write: bool,
    gate: bool = False,
    min_grounded: float | None = None,
    min_refusal: float | None = None,
) -> int:
    path = results or latest_artifact_path()
    if path is None:
        logger.error("No run artifacts in %s — run the eval first.", _RESULTS_DIR)
        return 1

    path = path.resolve()  # so --results with a relative path still matches the glob
    artifact = load_artifact(path)
    scores = score_artifact(artifact)

    # Re-score every saved run rather than keeping a separate history file:
    # the history then always reflects the current rules, and can't drift.
    history: list[qa_scoring.QASummary] = []
    for other in _artifact_paths():
        past = artifact if other == path else load_artifact(other)
        history.append(qa_scoring.summarize(past, scores if other == path else score_artifact(past)))

    if baseline is None and gate:
        baseline = previous_artifact_path(path)
        if baseline is None:
            logger.info("No run earlier than %s — regression check skipped.", path.name)

    failures: list[str] = []
    baseline_summary = None
    if baseline is not None:
        base_artifact = load_artifact(baseline)
        base_scores = score_artifact(base_artifact)
        baseline_summary = qa_scoring.summarize(base_artifact, base_scores)
        for regression in qa_scoring.regressions(scores, base_scores):
            logger.log(
                logging.ERROR if gate else logging.WARNING,
                "REGRESSION vs baseline: %s",
                regression,
            )
            failures.append(regression)

    report = qa_scoring.render_markdown(artifact, scores, history, baseline_summary)
    print(report)
    if write:
        _REPORT_PATH.parent.mkdir(exist_ok=True)
        _REPORT_PATH.write_text(report)
        logger.info("Wrote %s", _REPORT_PATH)
        _write_readme_summary(qa_scoring.summarize(artifact, scores))

    result = qa_scoring.totals(scores)
    if not result.answerable and not result.unanswerable:
        logger.error("Artifact has no scorable questions.")
        return 1
    if gate:
        floor_grounded, floor_refusal = load_gate()
        _check_floor(
            "grounded rate",
            result.grounded_rate,
            min_grounded if min_grounded is not None else floor_grounded,
            failures,
        )
        _check_floor(
            "refusal rate",
            result.refusal_rate,
            min_refusal if min_refusal is not None else floor_refusal,
            failures,
        )
        if failures:
            logger.error("GATE FAILED — %d issue(s) above.", len(failures))
            return 2
        logger.info("GATE PASSED.")
    return 0


# --- CLI ---

async def _dispatch(args: argparse.Namespace) -> int:
    """No app lifespan here, so the shared EDGAR client is closed by hand."""
    try:
        if args.command == "build-corpus":
            return await build_corpus(
                [t.upper() for t in args.ticker] if args.ticker else None, args.refresh
            )

        if args.command == "check-golden":
            return check_golden()

        if args.command == "run":
            code, path = await run(
                ticker=args.ticker.upper() if args.ticker else None,
                limit=args.limit,
                sleep=args.sleep,
                tag=args.tag,
                allow_fallback=args.allow_fallback,
            )
            if path is not None and not args.no_score:
                score(
                    results=path,
                    baseline=Path(args.baseline) if args.baseline else None,
                    write=True,
                )
            return code

        return score(
            results=Path(args.results) if args.results else None,
            baseline=Path(args.baseline) if args.baseline else None,
            write=not args.no_write,
            gate=args.gate,
            min_grounded=args.min_grounded,
            min_refusal=args.min_refusal,
        )
    finally:
        await edgar.close_client()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build-corpus", help="Chunk + embed the filings (SPENDS embedding quota)")
    build.add_argument("--ticker", action="append", help="Only this ticker (repeatable)")
    build.add_argument("--refresh", action="store_true", help="Rebuild filings already on disk")

    sub.add_parser("check-golden", help="Verify every retrieval label occurs in the corpus (free)")

    run_cmd = sub.add_parser("run", help="Retrieve + answer (SPENDS Gemini quota), then score")
    run_cmd.add_argument("--ticker", help="Only this ticker")
    run_cmd.add_argument("--limit", type=int, help="Stop after N questions")
    run_cmd.add_argument(
        "--sleep",
        type=float,
        default=_DEFAULT_SLEEP,
        help=f"Seconds between questions, for free-tier RPM (default {_DEFAULT_SLEEP:g})",
    )
    run_cmd.add_argument("--tag", help="Suffix the artifact filename to keep same-day runs apart")
    run_cmd.add_argument(
        "--allow-fallback",
        action="store_true",
        help="Permit the Q&A model pair to fall back (mixes models in one report)",
    )
    run_cmd.add_argument("--no-score", action="store_true", help="Write the artifact only")
    run_cmd.add_argument("--baseline", help="Artifact to compare the new run against")

    score_cmd = sub.add_parser("score", help="Score a saved run (free, no corpus, no network)")
    score_cmd.add_argument("--results", help="Artifact to score (default: newest)")
    score_cmd.add_argument("--baseline", help="Artifact to compare against")
    score_cmd.add_argument("--no-write", action="store_true", help="Print without writing docs/evals-qa.md")
    score_cmd.add_argument(
        "--gate",
        action="store_true",
        help="Exit 2 on a regression against the previous run, or below gate.json's floors",
    )
    score_cmd.add_argument(
        "--min-grounded",
        type=float,
        help="Override gate.json's grounded-rate floor, as a fraction (e.g. 0.9)",
    )
    score_cmd.add_argument(
        "--min-refusal",
        type=float,
        help="Override gate.json's refusal-rate floor, as a fraction (e.g. 0.8)",
    )

    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    try:
        return asyncio.run(_dispatch(args))
    except KeyboardInterrupt:
        logger.warning("Interrupted — anything already written is kept.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
