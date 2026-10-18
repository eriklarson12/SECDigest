import asyncio
import logging
import re

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse

from app import quota
from app.models.schemas import (
    TICKER_RE,
    AnalysisRequest,
    AnalysisResponse,
    AnalysisListResponse,
    AskRequest,
    AskResponse,
    AskSource,
    DriftResponse,
    IndexStatusResponse,
    NovelPassage,
    SectorCountsResponse,
    SimilarFiling,
    SimilarFilingsResponse,
)
from app.cache import drift_cache
from app.ratelimit import ask_limit, limiter
from app.routers import analysis_pipeline
from app.routers.llm_guards import llm_errors, require_quota
from app.services import (
    database,
    drift,
    edgar,
    embeddings,
    indexing,
    units,
)
from app.services.company_names import clean_company_name
from app.services.llm import answer_question

logger = logging.getLogger(__name__)

# Shorter than four digits only reaches here from a hand-edited URL; zfill below makes
# it match, because EDGAR codes are zero-padded and 0700 is a real one.
_SIC_RE = re.compile(r"^\d{1,4}$")

# Retrieved excerpts per question, and how much of each is echoed back as a source
_RETRIEVAL_K = 6
_EXCERPT_CHARS = 300

# The analysis page reads this many rows of ticker history. Drift picks its prior from the same
# read, so the two sides choose from the same rows, and the request is a list_cache hit.
_HISTORY_LIMIT = 12

router = APIRouter(prefix="/api/analysis", tags=["analysis"])


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
        return await analysis_pipeline.run_analysis(payload, background_tasks)

    # slowapi injects X-RateLimit-* into a returned Response directly when the endpoint
    # returns one (extension.py), so those survive; these two do not come from anywhere else.
    return StreamingResponse(
        analysis_pipeline.stream_analysis(payload, background_tasks),
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
    sic: str | None = Query(None, min_length=1, max_length=4),
    owner_org: str | None = Query(None, min_length=1, max_length=64),
):
    """List stored analyses, optionally filtered by ticker (powers TrendChart), by SEC
    industry code (the badge link from roadmap 8.2), and by SEC review office (the sector
    line from roadmap 8.5). Any may be set; they AND.

    `owner_org` takes the raw EDGAR value ("06 Technology") or the literal
    `unclassified` for rows EDGAR never classified. It carries no pattern: review offices
    are free text and not every one is numbered ("International Corp Fin")."""
    if ticker is not None:
        ticker = ticker.upper()
        if not TICKER_RE.match(ticker):
            raise HTTPException(status_code=422, detail="Invalid ticker format")

    if sic is not None:
        if not _SIC_RE.match(sic):
            raise HTTPException(status_code=422, detail="Invalid SIC format")
        sic = sic.zfill(4)

    analyses, total = await database.list_analyses(
        limit=limit, offset=offset, ticker=ticker, sic=sic, owner_org=owner_org
    )
    return AnalysisListResponse(analyses=analyses, total=total)


# MUST stay above `/{analysis_id}`: FastAPI matches in declaration order, and an int path
# param below would claim "sectors" and answer 422.
@router.get("/sectors", response_model=SectorCountsResponse)
@limiter.limit("60/minute")
async def sector_counts(request: Request, response: Response):
    """Analyses per SEC review office, across the whole corpus (roadmap 8.5).

    Raw values and counts only. The display label and the ordering are the frontend's,
    and live in `lib/format.ts` beside the SEC industry line's own formatter.

    Still uncached, but no longer for the reason recorded here before roadmap 10.2: the
    analyze path *does* have an invalidation hook (`database._create_analysis_sync`, which
    is what clears `list_cache`). It stays uncached because a scan of one narrow column is
    cheap, and because a surface whose whole job is reporting corpus size should not report
    a stale one. It shares the concurrency ceiling the list path has, so if this ever
    stacks, `list_cache`'s shape is the thing to copy."""
    return SectorCountsResponse(sectors=await database.sector_counts())


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
        state=status.state,
        chunks_indexed=status.chunks_indexed,
        chunks_total=status.chunks_total,
    )


@router.get("/{analysis_id}/similar", response_model=SimilarFilingsResponse)
@limiter.limit("60/minute")
async def similar_filings(
    request: Request,
    response: Response,
    analysis_id: int,
    limit: int = Query(5, ge=1, le=20),
):
    """Filings whose language sits nearest this one's (roadmap 9.1).

    Reads the centroids already derived from the Q&A embedding corpus, so it costs no
    embedding, EDGAR or LLM request. Deliberately uncached, for sector_counts' reason and
    one more: the corpus grows on the analyze path *and* on the background index-completion
    path, neither of which has a hook to invalidate a TTL, and a stale peer list on a surface
    whose whole claim is "of the corpus analyzed here" is worse than a scan of a small table.

    Ranking lives entirely in the match_companies RPC. No filtering by form type or industry
    belongs here: a peer sharing the subject's SIC is a real result, and re-deriving Tier 8 in
    Python would defeat the point of the feature.
    """
    analysis = await database.get_by_id(analysis_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")

    rows = await database.match_companies(analysis.accession_number, limit)
    peers = [
        SimilarFiling(
            analysis_id=row["analysis_id"],
            accession_number=row["accession_number"],
            ticker=row["ticker"],
            company_name=clean_company_name(row["company_name"]),
            form_type=row["form_type"],
            filing_date=row.get("filing_date"),
            sic=row.get("sic"),
            sic_description=row.get("sic_description"),
            similarity=row["similarity"],
        )
        for row in rows
    ]
    if peers:
        return SimilarFilingsResponse(peers=peers, pool=rows[0]["pool"], available=True)

    # Only the empty case pays a second round trip, to tell "this filing has no centroid"
    # apart from "no other company does".
    available = await database.filing_vector_chunks(analysis.accession_number) is not None
    return SimilarFilingsResponse(peers=[], pool=0, available=available)


@router.get("/{analysis_id}/drift", response_model=DriftResponse)
@limiter.limit("60/minute")
async def filing_drift(request: Request, response: Response, analysis_id: int):
    """How much of this filing's text carries over from the prior same-form filing (roadmap 12.1).

    Reads embeddings already stored for Q&A, so it costs no embedding, EDGAR or LLM request."""
    analysis = await database.get_by_id(analysis_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")

    history, _ = await database.list_analyses(
        limit=_HISTORY_LIMIT, ticker=analysis.ticker
    )
    prior = drift.pick_prior(analysis, history)
    if prior is None:
        return DriftResponse(state="no_prior")

    key = f"{analysis.accession_number}:{prior.accession_number}"
    cached = drift_cache.get(key)
    if cached is not None:
        return cached

    base = DriftResponse(
        state="not_indexed",
        prior_analysis_id=prior.id,
        prior_form_type=prior.form_type,
        prior_filing_date=prior.filing_date,
    )
    # A partial index would read as drift: the missing chunks have no match to find.
    statuses = await asyncio.gather(
        indexing.status_for(analysis.accession_number, analysis.chunks_expected),
        indexing.status_for(prior.accession_number, prior.chunks_expected),
    )
    if any(s.state != indexing.COMPLETE for s in statuses):
        return base

    rows = await database.filing_drift(analysis.accession_number, prior.accession_number)
    if not rows:
        return base

    below = drift.novel_indexes(rows)
    contents = await database.chunk_contents(analysis.accession_number, below)
    prose = [i for i in below if i in contents and not drift.is_boilerplate(contents[i])]
    skipped = len(below) - len(prose)
    compared = len(rows) - skipped

    passages: list[NovelPassage] = []
    if prose:
        prior_text = drift.join_chunks(
            await database.all_chunk_contents(prior.accession_number)
        )
        for i in prose:
            comparison = drift.compare(contents[i], prior_text, starts_clean=i == 0)
            if comparison is None:
                continue
            passages.append(
                NovelPassage(
                    chunk_index=i,
                    excerpt=comparison.excerpt,
                    prior_excerpt=comparison.prior_excerpt,
                )
            )
            if len(passages) == drift.MAX_NOVEL_PASSAGES:
                break

    result = base.model_copy(
        update={
            "state": "ok",
            "carried_over": (compared - len(prose)) / compared if compared else 1.0,
            "mean_similarity": sum(r["max_similarity"] for r in rows) / len(rows),
            "novel_passages": passages,
        }
    )
    drift_cache.set(key, result)
    return result


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
@ask_limit
async def ask_filing(
    request: Request, response: Response, analysis_id: int, payload: AskRequest
):
    """Answer a question from the filing's own text: embeds the question, retrieves nearest chunks, Gemini answers from those only.
    Zero matches → 404, covering both a pre-Q&A analysis (permanently empty) and an index still in progress — use /index-status to tell them apart."""
    analysis = await database.get_by_id(analysis_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")

    # Two Gemini calls per question — spend a unit of the shared daily budget
    await require_quota()

    with llm_errors("Question embedding failed for %s", analysis_id):
        [question_embedding] = await embeddings.embed_texts(
            [payload.question], embeddings.QUERY_TASK
        )
    try:
        matches = await database.match_chunks(
            analysis.accession_number, question_embedding, _RETRIEVAL_K
        )
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

    with llm_errors("Q&A generation failed for %s", analysis_id):
        answer = await answer_question(
            payload.question, [m["content"] for m in matches], unit_scale
        )

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
