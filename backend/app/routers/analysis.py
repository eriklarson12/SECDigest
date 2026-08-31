import asyncio
import json
import logging
import re
from collections.abc import AsyncIterator, Awaitable, Callable

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse

from app import quota
from app.models.schemas import (
    AnalysisRequest,
    AnalysisResponse,
    AnalysisListResponse,
    AskRequest,
    AskResponse,
    AskSource,
    IndexStatusResponse,
)
from app.ratelimit import limiter
from app.services import database, edgar, embeddings, indexing, units
from app.services.llm import analyze_filing, answer_question, LLMError, LLMQuotaError

logger = logging.getLogger(__name__)

_TICKER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9.\-]{0,9}$")

# Retrieved excerpts per question, and how much of each is echoed back as a source
_RETRIEVAL_K = 6
_EXCERPT_CHARS = 300

# Streamed stage names, in pipeline order. The frontend checklist mirrors this list.
CACHE_CHECK = "cache_check"
FETCHING_FILING = "fetching_filing"
EXTRACTING = "extracting"
STORING = "storing"

# Heroku's router closes a connection idle for more than 30s, and `extracting` is a
# single await that regularly runs most of a minute. A comment frame resets that clock.
_KEEPALIVE_SECONDS = 20.0

# Producer tasks outlive the generator that reads them when a client disconnects mid-run;
# without a strong reference the loop is free to collect one and lose a paid-for analysis.
_producers: set[asyncio.Task] = set()

router = APIRouter(prefix="/api/analysis", tags=["analysis"])


async def _run_analysis(
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
        filing_text = await edgar.fetch_filing_text(
            cik=payload.cik,
            accession_number=payload.accession_number,
            primary_document=payload.primary_document,
        )
    except httpx.HTTPError:
        logger.warning("EDGAR fetch failed for %s", payload.accession_number, exc_info=True)
        raise HTTPException(status_code=502, detail="Failed to fetch filing from EDGAR")

    if not filing_text.strip():
        raise HTTPException(status_code=422, detail="Filing document was empty")

    # Consumed from the global daily budget only on cache misses that reach the
    # LLM (protects the shared Gemini free-tier quota).
    if not await quota.try_consume():
        raise HTTPException(
            status_code=503,
            detail="Daily analysis capacity reached — try again tomorrow",
            headers={"Retry-After": "3600"},
        )

    await stage(EXTRACTING)
    try:
        analysis = await analyze_filing(
            filing_text,
            form_type=payload.form_type,
            company_name=payload.company_name,
            ticker=payload.ticker,
        )
    except LLMQuotaError:
        raise HTTPException(
            status_code=503,
            detail="Analysis service is at capacity — try again in a minute",
            headers={"Retry-After": "60"},
        )
    except LLMError:
        logger.warning("LLM analysis failed for %s", payload.accession_number, exc_info=True)
        raise HTTPException(status_code=502, detail="LLM analysis failed")

    # Durable index target: without it a restart clears the in-process total and a partial
    # index reports itself complete (services/indexing.py).
    chunks_expected = len(embeddings.chunk_text(filing_text))

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


async def _stream_analysis(
    payload: AnalysisRequest, background_tasks: BackgroundTasks
) -> AsyncIterator[str]:
    """`stage` frames while the pipeline runs, then exactly one `result` or `error`.

    The pipeline runs in its own task rather than inline because `extracting` is a
    single long await: a generator cannot emit a keepalive during its own await.
    Stages arrive as `str`, the terminal frame as a tuple — that is the discriminator."""
    queue: asyncio.Queue[str | tuple[str, dict]] = asyncio.Queue()

    async def produce() -> None:
        try:
            stored = await _run_analysis(payload, background_tasks, on_stage=queue.put)
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


@router.post("", response_model=AnalysisResponse)
@limiter.limit("6/minute")
async def create_analysis(
    request: Request,
    response: Response,
    payload: AnalysisRequest,
    background_tasks: BackgroundTasks,
):
    """Analyze a filing: check cache → fetch → LLM → store → return.

    `Accept: text/event-stream` streams the same pipeline's stage progress as SSE and
    ends with one `result` or `error` frame; every other client gets today's JSON,
    byte for byte. Once the stream opens the status is 200 and failures travel in the
    `error` frame — only pre-handler rejections (429, 413) stay HTTP statuses."""
    if "text/event-stream" not in request.headers.get("accept", ""):
        return await _run_analysis(payload, background_tasks)

    # slowapi injects X-RateLimit-* into a returned Response directly when the endpoint
    # returns one (extension.py), so those survive; these two do not come from anywhere else.
    return StreamingResponse(
        _stream_analysis(payload, background_tasks),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # Proxy buffering would hold every frame until the last one, which is
            # indistinguishable from not having built this at all.
            "X-Accel-Buffering": "no",
        },
    )


@router.get("", response_model=AnalysisListResponse)
@limiter.limit("60/minute")
async def list_analyses(
    request: Request,
    response: Response,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    ticker: str | None = Query(None, min_length=1, max_length=10),
):
    """List stored analyses, optionally filtered by ticker (powers TrendChart)."""
    if ticker is not None:
        if not _TICKER_RE.match(ticker):
            raise HTTPException(status_code=422, detail="Invalid ticker format")
        ticker = ticker.upper()

    analyses, total = await database.list_analyses(limit=limit, offset=offset, ticker=ticker)
    return AnalysisListResponse(analyses=analyses, total=total)


@router.get("/{analysis_id}", response_model=AnalysisResponse)
@limiter.limit("60/minute")
async def get_analysis(request: Request, response: Response, analysis_id: int):
    result = await database.get_by_id(analysis_id)
    if not result:
        raise HTTPException(status_code=404, detail="Analysis not found")
    return result


@router.get("/{analysis_id}/index-status", response_model=IndexStatusResponse)
@limiter.limit("60/minute")
async def index_status(request: Request, response: Response, analysis_id: int):
    """Q&A coverage for one filing — polled by the Ask card while indexing runs.
    Coverage is time-varying: a question may be unanswerable seconds after analysis, answerable minutes later."""
    analysis = await database.get_by_id(analysis_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")

    status = await indexing.status_for(
        analysis.accession_number, analysis.chunks_expected
    )
    return IndexStatusResponse(
        state=status.state,  # pyright: ignore[reportArgumentType]
        chunks_indexed=status.chunks_indexed,
        chunks_total=status.chunks_total,
    )


@router.post("/{analysis_id}/reindex", response_model=IndexStatusResponse)
@limiter.limit("2/minute")
async def reindex_filing(
    request: Request,
    response: Response,
    analysis_id: int,
    background_tasks: BackgroundTasks,
):
    """Re-run Q&A indexing for a filing whose index is missing or short.
    `POST /analysis` cannot do this: accession_number is UNIQUE, so it returns the cached row
    without reaching the indexer. Indexing resumes from the stored chunk count, so a filing
    left partial only pays for what it is missing."""
    analysis = await database.get_by_id(analysis_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")

    indexed = await database.chunk_count(analysis.accession_number)
    # A known-complete index needs no EDGAR round trip to confirm.
    if analysis.chunks_expected and indexed >= analysis.chunks_expected:
        return IndexStatusResponse(
            state=indexing.COMPLETE,
            chunks_indexed=indexed,
            chunks_total=analysis.chunks_expected,
        )

    document = await edgar.resolve_primary_document(
        analysis.cik, analysis.accession_number
    )
    if document is None:
        raise HTTPException(
            status_code=404, detail="Filing is no longer listed in EDGAR"
        )

    try:
        filing_text = await edgar.fetch_filing_text(
            cik=analysis.cik,
            accession_number=analysis.accession_number,
            primary_document=document,
        )
    except httpx.HTTPError:
        logger.warning(
            "EDGAR re-fetch failed for %s", analysis.accession_number, exc_info=True
        )
        raise HTTPException(status_code=502, detail="Failed to fetch filing from EDGAR")

    if not filing_text.strip():
        raise HTTPException(status_code=422, detail="Filing document was empty")

    total = len(embeddings.chunk_text(filing_text))
    if total != analysis.chunks_expected:
        # Also repairs rows stored before the column existed.
        await database.set_chunks_expected(analysis.accession_number, total)

    if indexed >= total:
        return IndexStatusResponse(
            state=indexing.COMPLETE, chunks_indexed=indexed, chunks_total=total
        )

    # Refuse before starting, not halfway through: the daily ceiling is Google's, and a run
    # that exhausts it mid-filing is exactly what leaves an index short.
    if await quota.embeddings_remaining() < total - indexed:
        raise HTTPException(
            status_code=503,
            detail="Daily indexing budget spent — this filing can be indexed tomorrow",
            headers={"Retry-After": "3600"},
        )

    indexing.mark_scheduled(analysis.accession_number, total)
    background_tasks.add_task(
        indexing.run_index, analysis.accession_number, filing_text
    )
    return IndexStatusResponse(
        state=indexing.INDEXING, chunks_indexed=indexed, chunks_total=total
    )


@router.post("/{analysis_id}/ask", response_model=AskResponse)
@limiter.limit("6/minute")
async def ask_filing(
    request: Request, response: Response, analysis_id: int, payload: AskRequest
):
    """Answer a question from the filing's own text: embeds the question, retrieves nearest chunks, Gemini answers from those only.
    Zero matches → 404, covering both a pre-Q&A analysis (permanently empty) and an index still in progress — use /index-status to tell them apart."""
    analysis = await database.get_by_id(analysis_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")

    # Two Gemini calls per question — spend a unit of the shared daily budget
    if not await quota.try_consume():
        raise HTTPException(
            status_code=503,
            detail="Daily analysis capacity reached — try again tomorrow",
            headers={"Retry-After": "3600"},
        )

    try:
        [question_embedding] = await embeddings.embed_texts(
            [payload.question], embeddings.QUERY_TASK
        )
        matches = await database.match_chunks(
            analysis.accession_number, question_embedding, _RETRIEVAL_K
        )
    except LLMQuotaError:
        raise HTTPException(
            status_code=503,
            detail="Analysis service is at capacity — try again in a minute",
            headers={"Retry-After": "60"},
        )
    except LLMError:
        logger.warning("Question embedding failed for %s", analysis_id, exc_info=True)
        raise HTTPException(status_code=502, detail="LLM analysis failed")
    except Exception:
        logger.exception("Chunk retrieval failed for %s", analysis_id)
        raise HTTPException(status_code=502, detail="LLM analysis failed")

    if not matches:
        raise HTTPException(
            status_code=404, detail="Q&A isn't available for this filing"
        )

    # The filing states its scale in a section header the excerpts rarely include —
    # anchor on the closest match so the governing declaration wins (units.py).
    unit_scale = await units.scale_for(
        analysis.accession_number, matches[0]["chunk_index"]
    )

    try:
        answer = await answer_question(
            payload.question, [m["content"] for m in matches], unit_scale
        )
    except LLMQuotaError:
        raise HTTPException(
            status_code=503,
            detail="Analysis service is at capacity — try again in a minute",
            headers={"Retry-After": "60"},
        )
    except LLMError:
        logger.warning("Q&A generation failed for %s", analysis_id, exc_info=True)
        raise HTTPException(status_code=502, detail="LLM analysis failed")

    return AskResponse(
        answer=answer,
        sources=[
            AskSource(
                chunk_index=m["chunk_index"],
                excerpt=m["content"][:_EXCERPT_CHARS],
            )
            for m in matches
        ],
        unit_scale=unit_scale,
    )
