import logging
import re

from fastapi import APIRouter, HTTPException, Query, Request, Response

from app.models.schemas import CompanyPeers, CompanyProfile, CompanySearchResult
from app.ratelimit import limiter
from app.services import edgar

logger = logging.getLogger(__name__)

_CIK_RE = re.compile(r"^\d{1,10}$")
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
        # Startup ticker load can fail if SEC was briefly down. Without the map every peer is
        # dropped on the intersection, so the list would come back empty rather than degraded.
        if not edgar.ticker_map_loaded():
            try:
                await edgar.load_tickers()
            except Exception:
                logger.warning("Lazy ticker map load failed", exc_info=True)
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
