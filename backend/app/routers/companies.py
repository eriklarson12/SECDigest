import logging

from fastapi import APIRouter, Query, Request, Response

from app.models.schemas import CompanySearchResult
from app.ratelimit import limiter
from app.services import edgar

logger = logging.getLogger(__name__)

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
