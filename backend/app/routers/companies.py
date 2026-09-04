import logging
import re

from fastapi import APIRouter, HTTPException, Query, Request, Response

from app.models.schemas import CompanyProfile, CompanySearchResult
from app.ratelimit import limiter
from app.services import edgar

logger = logging.getLogger(__name__)

_CIK_RE = re.compile(r"^\d{1,10}$")

router = APIRouter(prefix="/api/companies", tags=["companies"])


@router.get("/search", response_model=list[CompanySearchResult])
@limiter.limit("30/minute")
async def search_companies(
    request: Request, response: Response, q: str = Query(..., min_length=1, max_length=40)
):
    """Search for companies by ticker or name."""
    # Startup ticker load can fail if SEC was briefly down — retry lazily
    if not edgar.ticker_map_loaded():
        try:
            await edgar.load_tickers()
        except Exception:
            logger.warning("Lazy ticker map load failed", exc_info=True)
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
