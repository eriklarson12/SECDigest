"""The analysis pipeline behind `POST /api/analysis`: cache -> fetch -> LLM -> store.

One pipeline, two response shapes. `run_analysis` returns the stored row for JSON clients;
`stream_analysis` wraps it in SSE stage frames. Failures are `HTTPException`s either way."""

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable

import httpx
from fastapi import BackgroundTasks, HTTPException

from app.models.schemas import AnalysisRequest, AnalysisResponse, CompanyProfile, SegmentRevenue
from app.routers.llm_guards import llm_errors, require_quota
from app.services import database, edgar, embeddings, indexing, red_flags, segments
from app.services.llm import analyze_filing

logger = logging.getLogger(__name__)

# Streamed stage names, in pipeline order. The frontend checklist mirrors this list.
CACHE_CHECK = "cache_check"
FETCHING_FILING = "fetching_filing"
EXTRACTING = "extracting"
STORING = "storing"

# Heroku's router closes a connection idle for more than 30s, and `extracting` is a
# single await that regularly runs most of a minute. A comment frame resets that clock.
_KEEPALIVE_SECONDS = 20.0

# Generous for a cache hit, and short enough to abandon a throttled cold fetch rather than
# hold a finished analysis hostage to a badge.
_PROFILE_TIMEOUT_SECONDS = 10.0

# Producer tasks outlive the generator that reads them when a client disconnects mid-run;
# without a strong reference the loop is free to collect one and lose a paid-for analysis.
_producers: set[asyncio.Task] = set()


def _parse_segments(html: str, form_type: str, accession_number: str) -> SegmentRevenue | None:
    """Swallowed like the profile lookup: the daily cap is spent by the time this result is
    stored, and a missing revenue breakdown must never cost a finished analysis."""
    try:
        return segments.parse_segments(html, form_type, accession_number)
    except Exception:
        logger.warning("Segment parse failed for %s", accession_number, exc_info=True)
        return None


async def run_analysis(
    payload: AnalysisRequest,
    background_tasks: BackgroundTasks,
    on_stage: Callable[[str], Awaitable[None]] | None = None,
) -> AnalysisResponse:
    """The pipeline both response shapes share: cache -> fetch -> LLM -> store.

    Raises `HTTPException` exactly as the JSON endpoint always has. The streaming
    wrapper catches those and re-emits them as `error` frames, so there is one
    error-status contract rather than two that can drift."""

    async def stage(name: str) -> None:
        if on_stage is not None:
            await on_stage(name)

    await stage(CACHE_CHECK)
    # accession_number is UNIQUE — one analysis per filing, ever.
    cached = await database.get_by_accession(payload.accession_number)
    if cached:
        return cached

    await stage(FETCHING_FILING)
    try:
        html = await edgar.fetch_filing_html(
            cik=payload.cik,
            accession_number=payload.accession_number,
            primary_document=payload.primary_document,
        )
    except httpx.HTTPError:
        logger.warning("EDGAR fetch failed for %s", payload.accession_number, exc_info=True)
        raise HTTPException(status_code=502, detail="Failed to fetch filing from EDGAR")

    # Uncapped: Item 9A and the auditor's report can sit past the LLM cap (roadmap 12.4).
    full_text = edgar.html_to_text(html)

    if not full_text.strip():
        raise HTTPException(status_code=422, detail="Filing document was empty")
    # Same document, so no EDGAR request of its own (roadmap 12.8). A thread, because a 13 MB
    # JPM parse is most of a second on the one worker's event loop.
    segment_revenue = await asyncio.to_thread(
        _parse_segments, html, payload.form_type, payload.accession_number
    )
    filing_text = edgar.cap_filing_text(full_text)
    flags = red_flags.detect_text_flags(
        full_text, payload.form_type, payload.filing_date, payload.accession_number
    )

    # Consumed from the global daily budget only on cache misses that reach the
    # LLM (protects the shared Gemini free-tier quota).
    await require_quota()

    await stage(EXTRACTING)
    with llm_errors("LLM analysis failed for %s", payload.accession_number):
        analysis = await analyze_filing(
            filing_text,
            form_type=payload.form_type,
            company_name=payload.company_name,
            ticker=payload.ticker,
        )

    # Durable index target: without it a restart clears the in-process total and a partial
    # index reports itself complete (services/indexing.py).
    chunks_expected = len(embeddings.chunk_text(filing_text))

    # Normally free: the /filings request that listed this filing parsed the same submissions
    # document seconds ago and left the profile in profile_cache. Bounded *and* swallowed —
    # the daily cap is already spent by here, and a throttled EDGAR does not raise, it
    # succeeds ~95s later (3 attempts x 30s + backoff), which no except clause would catch.
    try:
        profile = await asyncio.wait_for(
            edgar.get_company_profile(payload.cik), timeout=_PROFILE_TIMEOUT_SECONDS
        )
    except Exception:
        logger.warning("Company profile lookup failed for CIK %s", payload.cik, exc_info=True)
        profile = CompanyProfile(cik=payload.cik)

    # Concurrent duplicate inserts return the existing row.
    row_data = {
        "accession_number": payload.accession_number,
        "cik": payload.cik,
        "ticker": payload.ticker,
        "company_name": payload.company_name,
        "form_type": payload.form_type,
        "filing_date": payload.filing_date,
        "revenue_current": analysis.revenue.current,
        "revenue_yoy_change_pct": analysis.revenue.yoy_change_pct,
        "net_income_current": analysis.net_income.current,
        "net_income_yoy_change_pct": analysis.net_income.yoy_change_pct,
        "risk_factors": analysis.risk_factors,
        "management_guidance": analysis.management_guidance,
        "summary": analysis.summary,
        "chunks_expected": chunks_expected,
        "sic": profile.sic,
        "sic_description": profile.sic_description,
        "owner_org": profile.owner_org,
        "flags": [flag.model_dump() for flag in flags],
        "segments": segment_revenue.model_dump() if segment_revenue else None,
    }

    await stage(STORING)
    try:
        stored = await database.create_analysis(row_data)
    except Exception:
        logger.exception("Failed to store analysis for %s", payload.accession_number)
        raise HTTPException(status_code=500, detail="Failed to store analysis")

    # Scheduled, never awaited: a full index takes minutes against the 30k tokens/minute cap, so it
    # runs after the response while the Ask card polls /index-status; a shared lock serializes jobs.
    indexing.mark_scheduled(stored.accession_number, chunks_expected)
    background_tasks.add_task(indexing.run_index, stored.accession_number, filing_text)

    return stored


def _frame(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


async def stream_analysis(
    payload: AnalysisRequest, background_tasks: BackgroundTasks
) -> AsyncIterator[str]:
    """`stage` frames while the pipeline runs, then exactly one `result` or `error`.

    The pipeline runs in its own task rather than inline because `extracting` is a
    single long await: a generator cannot emit a keepalive during its own await.
    Stages arrive as `str`, the terminal frame as a tuple — that is the discriminator."""
    queue: asyncio.Queue[str | tuple[str, dict]] = asyncio.Queue()

    async def produce() -> None:
        try:
            stored = await run_analysis(payload, background_tasks, on_stage=queue.put)
            await queue.put(("result", stored.model_dump(mode="json")))
        except HTTPException as exc:
            await queue.put(("error", {"status": exc.status_code, "detail": exc.detail}))
        except Exception:
            logger.exception("Streaming analysis failed for %s", payload.accession_number)
            await queue.put(("error", {"status": 500, "detail": "Internal server error"}))

    # Never cancelled on client disconnect: the daily quota unit is already spent by
    # then, so letting the store finish is what makes the user's retry a cache hit.
    producer = asyncio.create_task(produce())
    _producers.add(producer)
    producer.add_done_callback(_producers.discard)

    while True:
        try:
            item = await asyncio.wait_for(queue.get(), timeout=_KEEPALIVE_SECONDS)
        except TimeoutError:
            yield ": keepalive\n\n"
            continue
        if isinstance(item, str):
            yield _frame("stage", {"stage": item})
            continue
        event, data = item
        yield _frame(event, data)
        return
