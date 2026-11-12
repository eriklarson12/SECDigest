import asyncio
import logging
import re

import httpx
from fastapi import APIRouter, HTTPException, Query, Request, Response

from app.cache import ask_scope_cache
from app.models.schemas import (
    AskRequest,
    AskScopeFiling,
    AskScopeResponse,
    CompanyAskResponse,
    CompanyAskSource,
    CompanyPeers,
    CompanyProfile,
    CompanySearchResult,
    EarningsSummary,
    InsiderActivity,
    PayVersusPerformance,
)
from app.ratelimit import ask_limit, limiter
from app.routers.filings import cached_filings
from app.routers.llm_guards import llm_errors, require_quota
from app.services import database, earnings, edgar, embeddings, retrieval, units
from app.services.excerpts import display_excerpt
from app.services.llm import CompanyExcerpt, answer_company_question, summarize_earnings

logger = logging.getLogger(__name__)

_CIK_RE = re.compile(r"^\d{1,10}$")
_ACCESSION_RE = re.compile(r"^\d{10}-?\d{2}-?\d{6}$")
# The company page shows the newest ten 8-Ks (frontend `splitFilings`); only those can be summarized.
_EARNINGS_SCAN_LIMIT = 10
# /api/financials is limited to 30/minute and /benchmark seeds at most 10 companies,
# so a longer list would only ever be trimmed downstream.
_PEERS_LIMIT = 20

router = APIRouter(prefix="/api/companies", tags=["companies"])


@router.get("/search", response_model=list[CompanySearchResult])
@limiter.limit("30/minute")
async def search_companies(
    request: Request, response: Response, q: str = Query(..., min_length=1, max_length=40)
):
    """Search for companies by ticker or name."""
    await edgar.ensure_ticker_map()
    return edgar.search_tickers(q)


@router.get("/{cik}/profile", response_model=CompanyProfile)
@limiter.limit("30/minute")
async def get_company_profile(request: Request, response: Response, cik: str):
    """The filer's SEC industry classification (SIC code + review office).
    A filer EDGAR never classified returns null fields (200), which the frontend reads as "no badge"."""
    if not _CIK_RE.match(cik):
        raise HTTPException(status_code=422, detail="Invalid CIK format")

    try:
        return await edgar.get_company_profile(cik)
    except Exception:
        logger.warning("Company profile lookup failed for CIK %s", cik, exc_info=True)
        raise HTTPException(status_code=502, detail="Failed to fetch company profile from EDGAR")


@router.get("/{cik}/peers", response_model=CompanyPeers)
@limiter.limit("10/minute")
async def get_company_peers(request: Request, response: Response, cik: str):
    """Listed companies filed under the same SEC SIC as this one, most prominent first.

    Includes the requested company. Membership is the filer's own self-classification, which
    is blunt and often stale — a caller rendering this MUST label it as the SEC's code.

    A failing profile is a 502 like /profile, but a failing peer feed is a 200 with an empty
    list: those are different facts, and reporting "EDGAR is down" as "this filer has no
    industry" would be the same dishonesty the classification itself is labelled against."""
    if not _CIK_RE.match(cik):
        raise HTTPException(status_code=422, detail="Invalid CIK format")

    try:
        profile = await edgar.get_company_profile(cik)
    except Exception:
        logger.warning("Company profile lookup failed for CIK %s", cik, exc_info=True)
        raise HTTPException(status_code=502, detail="Failed to fetch company profile from EDGAR")

    peers: list[CompanySearchResult] = []
    if profile.sic:
        # Without the ticker map every peer is dropped on the intersection, so the list would
        # come back empty rather than degraded.
        await edgar.ensure_ticker_map()
        found = await edgar.get_peers(profile.sic)
        # The subject leads its own list, and is added when the scan never reached it: the
        # feed is alphabetical and depth-capped, so Microsoft is not among the 600 filers
        # EDGAR lists first under 7372. Ranking it by market cap instead would let the cap
        # of 20 cut a company out of its own industry.
        subject = edgar.company_by_cik(cik)
        if subject is None:
            peers = found[:_PEERS_LIMIT]
        else:
            rest = [peer for peer in found if int(peer.cik) != int(cik)]
            peers = [subject, *rest][:_PEERS_LIMIT]

    return CompanyPeers(
        cik=profile.cik,
        sic=profile.sic,
        sic_description=profile.sic_description,
        peers=peers,
    )


@router.get("/{cik}/insiders", response_model=InsiderActivity)
@limiter.limit("10/minute")
async def get_company_insiders(request: Request, response: Response, cik: str):
    """Open-market insider buys and sells from Form 4s filed in the last 90 days.

    A cold call costs up to 21 EDGAR requests, hence the peers-level limit. A Form 4 that fails
    to read is counted in `filings_failed`; only a failed submissions read is a 502."""
    if not _CIK_RE.match(cik):
        raise HTTPException(status_code=422, detail="Invalid CIK format")

    try:
        return await edgar.get_insider_activity(cik)
    except Exception:
        logger.warning("Insider activity lookup failed for CIK %s", cik, exc_info=True)
        raise HTTPException(status_code=502, detail="Failed to fetch insider activity from EDGAR")


@router.get("/{cik}/pay", response_model=PayVersusPerformance)
@limiter.limit("30/minute")
async def get_company_pay(request: Request, response: Response, cik: str):
    """CEO pay against shareholder return, from the newest proxy's tagged table (roadmap 15.1).

    A company with no proxy, or one whose proxy predates the tagging rule, gets empty `years`."""
    if not _CIK_RE.match(cik):
        raise HTTPException(status_code=422, detail="Invalid CIK format")

    try:
        return await edgar.get_pay_versus_performance(cik)
    except Exception:
        logger.warning("Pay versus performance lookup failed for CIK %s", cik, exc_info=True)
        raise HTTPException(status_code=502, detail="Failed to fetch executive pay from EDGAR")


def _unpadded_cik(cik: str) -> str:
    """422 on a malformed CIK; otherwise the unpadded form `analyses.cik` stores."""
    if not _CIK_RE.match(cik):
        raise HTTPException(status_code=422, detail="Invalid CIK format")
    return edgar.unpad_cik(cik)


def _scope_filing(row: dict) -> AskScopeFiling:
    return AskScopeFiling(
        analysis_id=row["analysis_id"],
        accession_number=row["accession_number"],
        form_type=row["form_type"],
        filing_date=row.get("filing_date"),
    )


@router.get("/{cik}/ask-scope", response_model=AskScopeResponse)
@limiter.limit("30/minute")
async def get_ask_scope(request: Request, response: Response, cik: str):
    """The indexed filings a company-level question would search, newest first. Spends no quota.
    The company page renders the ask panel only when `eligible`, and links a lone filing to its own ask."""
    key = _unpadded_cik(cik)
    cached = ask_scope_cache.get(key)
    if cached is not None:
        return cached

    try:
        rows = await database.company_indexed_filings(key, retrieval.MAX_FILINGS)
    except Exception:
        logger.exception("Ask scope lookup failed for CIK %s", key)
        raise HTTPException(status_code=502, detail="Failed to load the company's filings")

    scope = AskScopeResponse(
        filings=[_scope_filing(r) for r in rows], eligible=len(rows) >= 2
    )
    ask_scope_cache.set(key, scope)
    return scope


@router.post("/{cik}/ask", response_model=CompanyAskResponse)
@ask_limit
async def ask_company(request: Request, response: Response, cik: str, payload: AskRequest):
    """Answer a question across the company's latest indexed filings (roadmap 13.2).
    Fewer than two is a 404 before any quota is spent; a single filing is the per-filing ask's job."""
    key = _unpadded_cik(cik)
    try:
        rows = await database.company_indexed_filings(key, retrieval.MAX_FILINGS)
    except Exception:
        logger.exception("Ask scope lookup failed for CIK %s", key)
        raise HTTPException(status_code=502, detail="Failed to load the company's filings")
    if len(rows) < 2:
        raise HTTPException(
            status_code=404,
            detail="Asking across filings needs at least two indexed filings",
        )
    filings = {r["accession_number"]: _scope_filing(r) for r in rows}

    # Two Gemini calls per question, the same unit the per-filing ask spends.
    await require_quota()

    with llm_errors("Question embedding failed for CIK %s", key):
        [question_embedding] = await embeddings.embed_texts(
            [payload.question], embeddings.QUERY_TASK
        )
    try:
        candidates = await database.match_company_chunks(
            key, question_embedding, retrieval.PER_FILING, retrieval.MAX_FILINGS
        )
    except Exception:
        logger.exception("Chunk retrieval failed for CIK %s", key)
        raise HTTPException(status_code=502, detail="LLM analysis failed")

    # A filing indexed between the two RPCs is not in `filings`; skip it rather than guess its label.
    matches = retrieval.select_balanced(
        [c for c in candidates if c["accession_number"] in filings],
        filing_of=lambda m: m["accession_number"],
        similarity_of=lambda m: m["similarity"],
    )
    if not matches:
        raise HTTPException(
            status_code=404, detail="Q&A isn't available for these filings"
        )

    scales = await _scales_by_filing(matches)
    excerpts = [
        CompanyExcerpt(
            form_type=filings[m["accession_number"]].form_type,
            filing_date=filings[m["accession_number"]].filing_date,
            unit_scale=scales[m["accession_number"]],
            text=m["content"],
        )
        for m in matches
    ]
    with llm_errors("Company Q&A generation failed for CIK %s", key):
        answer = await answer_company_question(payload.question, excerpts)

    return CompanyAskResponse(
        answer=answer, sources=_company_sources(matches, filings, scales)
    )


async def _scales_by_filing(matches: list[dict]) -> dict[str, str | None]:
    """Each filing's scale, anchored on its own best match (units.py never raises)."""
    top_chunk: dict[str, int] = {}
    for m in matches:
        top_chunk.setdefault(m["accession_number"], m["chunk_index"])
    scales = await asyncio.gather(
        *(units.scale_for(a, i) for a, i in top_chunk.items())
    )
    return dict(zip(top_chunk, scales))


def _company_sources(
    matches: list[dict],
    filings: dict[str, AskScopeFiling],
    scales: dict[str, str | None],
) -> list[CompanyAskSource]:
    return [
        CompanyAskSource(
            analysis_id=filings[m["accession_number"]].analysis_id,
            accession_number=m["accession_number"],
            form_type=filings[m["accession_number"]].form_type,
            filing_date=filings[m["accession_number"]].filing_date,
            chunk_index=m["chunk_index"],
            excerpt=display_excerpt(m["content"], m["chunk_index"]),
            unit_scale=scales[m["accession_number"]],
        )
        for m in matches
    ]


@router.get("/{cik}/earnings", response_model=list[EarningsSummary])
@limiter.limit("60/minute")
async def list_earnings_summaries(request: Request, response: Response, cik: str):
    """Every stored earnings-release summary for the company, newest first (roadmap 15.3).
    Our own database only: it never calls EDGAR or the LLM."""
    unpadded = _unpadded_cik(cik)
    try:
        return await database.list_earnings_summaries(unpadded)
    except Exception:
        logger.warning("Earnings summary list failed for CIK %s", cik, exc_info=True)
        raise HTTPException(status_code=502, detail="Failed to load earnings summaries")


@router.post("/{cik}/earnings/{accession}", response_model=EarningsSummary)
@limiter.limit("6/minute")
async def summarize_earnings_release(
    request: Request, response: Response, cik: str, accession: str
):
    """Summarize one 8-K item 2.02 earnings release, once per release, ever.

    Cache-first like `POST /analysis`. The accession MUST be a 2.02 8-K among the company's
    newest ten, so the route cannot be pointed at an arbitrary document, and the daily quota is
    spent only after every free check has passed."""
    unpadded = _unpadded_cik(cik)
    if not _ACCESSION_RE.match(accession):
        raise HTTPException(status_code=422, detail="Invalid accession number format")
    dashless = accession.replace("-", "")

    stored = await database.get_earnings_summary(dashless)
    if stored and stored.cik == unpadded:
        return stored

    try:
        events = await cached_filings(cik, ["8-K"], _EARNINGS_SCAN_LIMIT)
    except httpx.HTTPError:
        logger.warning("Filings lookup failed for CIK %s", cik, exc_info=True)
        raise HTTPException(status_code=502, detail="Failed to fetch filings from EDGAR")
    if not any(
        f.accession_number.replace("-", "") == dashless and "2.02" in f.items for f in events
    ):
        raise HTTPException(
            status_code=404, detail="Not an earnings release in this company's recent filings"
        )

    try:
        release = await edgar.fetch_earnings_release(cik, dashless)
    except httpx.HTTPError:
        logger.warning("Earnings release fetch failed for %s", dashless, exc_info=True)
        raise HTTPException(status_code=502, detail="Failed to fetch the release from EDGAR")
    if release is None:
        raise HTTPException(status_code=404, detail="No earnings release exhibit in this filing")
    document, text = release
    if not text.strip():
        raise HTTPException(status_code=422, detail="The earnings release has no text")

    await require_quota()

    with llm_errors("Earnings summary failed for %s", dashless):
        extraction, model = await summarize_earnings(text)

    figures = earnings.keep_supported(extraction.figures, text)
    if len(figures) < len(extraction.figures):
        logger.info(
            "Dropped %d of %d unsupported figures for %s",
            len(extraction.figures) - len(figures),
            len(extraction.figures),
            dashless,
        )

    try:
        return await database.create_earnings_summary(
            {
                "accession_number": dashless,
                "cik": unpadded,
                "document": document,
                "summary": extraction.summary,
                "figures": [f.model_dump() for f in figures],
                "model": model,
            }
        )
    except Exception:
        logger.exception("Failed to store earnings summary for %s", dashless)
        raise HTTPException(status_code=500, detail="Failed to store earnings summary")
