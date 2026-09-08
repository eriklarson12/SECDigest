import asyncio
import logging
import re

import httpx
from fastapi import APIRouter, HTTPException, Request, Response

from app.cache import financials_cache
from app.models.schemas import FinancialsResponse
from app.ratelimit import limiter
from app.services import xbrl

logger = logging.getLogger(__name__)

_CIK_RE = re.compile(r"^\d{1,10}$")

router = APIRouter(prefix="/api/financials", tags=["financials"])


@router.get("/{cik}", response_model=FinancialsResponse)
@limiter.limit("30/minute")
async def get_financials(request: Request, response: Response, cik: str):
    """Exact annual + quarterly revenue/net income from SEC XBRL.
    An unknown CIK or untagged company returns empty series (200), which the frontend reads as "no trend available"."""
    if not _CIK_RE.match(cik):
        raise HTTPException(status_code=422, detail="Invalid CIK format")

    cached = financials_cache.get(cik)
    if cached is not None:
        return cached

    try:
        annual, quarters = await asyncio.gather(
            xbrl.get_annual_financials(cik),
            xbrl.get_quarterly_financials(cik),
        )
    except httpx.HTTPError:
        logger.warning("XBRL fetch failed for CIK %s", cik, exc_info=True)
        raise HTTPException(status_code=502, detail="Failed to fetch financials from SEC")

    # Revisions ride along on the annual payloads (roadmap 9.3) — no request of their own,
    # and the 1-hour cache below carries them for free.
    financials = FinancialsResponse(
        cik=cik, years=annual.years, quarters=quarters, revisions=annual.revisions
    )
    if annual.years or quarters:
        financials_cache.set(cik, financials)
    return financials
