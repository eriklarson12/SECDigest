import logging
import re

import httpx
from fastapi import APIRouter, HTTPException, Query, Request

from app import quota
from app.models.schemas import (
    AnalysisRequest,
    AnalysisResponse,
    AnalysisListResponse,
    AskRequest,
    AskResponse,
    AskSource,
)
from app.ratelimit import limiter
from app.services import database, edgar, embeddings
from app.services.llm import analyze_filing, answer_question, LLMError, LLMQuotaError

logger = logging.getLogger(__name__)

_TICKER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9.\-]{0,9}$")

# Retrieved excerpts per question, and how much of each is echoed back as a source
_RETRIEVAL_K = 6
_EXCERPT_CHARS = 300

router = APIRouter(prefix="/api/analysis", tags=["analysis"])


@router.post("", response_model=AnalysisResponse)
@limiter.limit("6/minute")
async def create_analysis(request: Request, payload: AnalysisRequest):
    """Analyze a filing: check cache → fetch → LLM → store → return."""
    # 1. Check cache (accession_number UNIQUE = one analysis per filing, ever)
    cached = await database.get_by_accession(payload.accession_number)
    if cached:
        return cached

    # 2. Fetch filing text from EDGAR
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

    # 3. Run LLM analysis — consumed from the global daily budget only on cache
    # misses that reach the LLM (protects the shared Gemini free-tier quota)
    if not quota.try_consume():
        raise HTTPException(
            status_code=503,
            detail="Daily analysis capacity reached — try again tomorrow",
            headers={"Retry-After": "3600"},
        )
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

    # 4. Store in database (concurrent duplicate inserts return the existing row)
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
    }

    try:
        stored = await database.create_analysis(row_data)
    except Exception:
        logger.exception("Failed to store analysis for %s", payload.accession_number)
        raise HTTPException(status_code=500, detail="Failed to store analysis")

    # 5. Index the filing for Q&A (roadmap 5.1). Inline so Q&A is ready by the
    # time the dashboard renders, but strictly best-effort: any failure means
    # /ask answers 404 for this filing, never that the analysis fails.
    try:
        chunks = await embeddings.index_filing(stored.accession_number, filing_text)
        logger.info("Indexed %d chunks for %s", chunks, stored.accession_number)
    except Exception:
        logger.warning(
            "Q&A indexing failed for %s", stored.accession_number, exc_info=True
        )

    return stored


@router.get("", response_model=AnalysisListResponse)
@limiter.limit("60/minute")
async def list_analyses(
    request: Request,
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
async def get_analysis(request: Request, analysis_id: int):
    """Get a single analysis by ID."""
    result = await database.get_by_id(analysis_id)
    if not result:
        raise HTTPException(status_code=404, detail="Analysis not found")
    return result


@router.post("/{analysis_id}/ask", response_model=AskResponse)
@limiter.limit("6/minute")
async def ask_filing(request: Request, analysis_id: int, payload: AskRequest):
    """Answer a question from the filing's own text (RAG — roadmap 5.1).

    Embed the question → nearest chunks for this filing → Gemini answers from
    those excerpts only. Filings analyzed before the feature shipped have no
    chunks and get a 404: re-analyzing can't help them (POST /analysis is
    cache-first on accession_number, so it never re-fetches the text).
    """
    analysis = await database.get_by_id(analysis_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")

    # Two Gemini calls per question — spend a unit of the shared daily budget
    if not quota.try_consume():
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

    try:
        answer = await answer_question(
            payload.question, [m["content"] for m in matches]
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
    )
