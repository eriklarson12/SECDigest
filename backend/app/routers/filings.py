import re

import httpx
from fastapi import APIRouter, HTTPException, Query, Request

from app.cache import filings_cache
from app.models.schemas import Filing
from app.ratelimit import limiter
from app.services.edgar import get_filings

_CIK_RE = re.compile(r"^\d{1,10}$")

router = APIRouter(prefix="/api/filings", tags=["filings"])


@router.get("/{cik}", response_model=list[Filing])
@limiter.limit("30/minute")
async def list_filings(
    request: Request,
    cik: str,
    form_type: str = Query("10-K,10-Q", description="Comma-separated form types"),
    limit: int = Query(10, ge=1, le=50),
):
    """List recent SEC filings for a company by CIK."""
    if not _CIK_RE.match(cik):
        raise HTTPException(status_code=422, detail="Invalid CIK format")

    cache_key = f"{cik}:{form_type}:{limit}"
    cached = filings_cache.get(cache_key)
    if cached is not None:
        return cached

    form_types = [ft.strip() for ft in form_type.split(",")]
    try:
        filings = await get_filings(cik, form_types=form_types, limit=limit)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            raise HTTPException(status_code=404, detail="Company not found")
        raise HTTPException(status_code=502, detail="Failed to fetch filings from EDGAR")
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Failed to fetch filings from EDGAR")

    if filings:
        filings_cache.set(cache_key, filings)
    return filings
