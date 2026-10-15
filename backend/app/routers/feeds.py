"""Atom feeds of new filings (roadmap 14.1). Served by the backend rather than a Next route:
a Vercel function would reach the API from Vercel's IPs, and every feed reader would share
one per-IP budget."""

import asyncio
import logging
import re
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query, Request, Response

from app.config import settings
from app.models.schemas import CompanySearchResult
from app.ratelimit import limiter
from app.routers.filings import cached_filings
from app.services import edgar
from app.services.feeds import (
    FEED_FORMS,
    MAX_ENTRIES,
    FeedEntry,
    make_feed_id,
    newest_first,
    render_atom,
)

logger = logging.getLogger(__name__)

_TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
# The watchlist's own MAX_ITEMS (frontend/src/lib/watchlist.ts).
MAX_TICKERS = 20
_ATOM = "application/atom+xml; charset=utf-8"
# Matches filings_cache's TTL, so a well-behaved reader polls no faster than the data changes.
_CACHE_CONTROL = "public, max-age=900"
_ATOM_RESPONSE: dict[int | str, dict[str, Any]] = {200: {"content": {"application/atom+xml": {}}}}

router = APIRouter(prefix="/api/feeds", tags=["feeds"])


async def _ensure_ticker_map() -> None:
    # Startup ticker load can fail if SEC was briefly down — retry lazily
    if not edgar.ticker_map_loaded():
        try:
            await edgar.load_tickers()
        except Exception:
            logger.warning("Lazy ticker map load failed", exc_info=True)
    if not edgar.ticker_map_loaded():
        raise HTTPException(status_code=502, detail="Failed to load the ticker map from EDGAR")


async def _entries(company: CompanySearchResult) -> list[FeedEntry]:
    filings = await cached_filings(company.cik, FEED_FORMS, MAX_ENTRIES)
    return [
        FeedEntry(ticker=company.ticker, cik=company.cik, company_name=company.name, filing=f)
        for f in filings
    ]


def _atom(body: str) -> Response:
    return Response(content=body, media_type=_ATOM, headers={"Cache-Control": _CACHE_CONTROL})


# Declared before the ticker route, which would otherwise capture "watchlist".
@router.get("/watchlist.atom", response_class=Response, responses=_ATOM_RESPONSE)
# Tighter than the ticker feed: a cold request costs up to MAX_TICKERS submissions fetches.
@limiter.limit("10/minute")
async def watchlist_feed(
    request: Request,
    response: Response,
    tickers: str = Query(..., max_length=500, description="Comma-separated tickers"),
):
    """New filings across a watchlist, newest first. Unknown tickers are dropped."""
    requested = list(
        dict.fromkeys(t.strip().upper() for t in tickers.split(",") if t.strip())
    )
    if not requested:
        raise HTTPException(status_code=422, detail="No tickers given")

    await _ensure_ticker_map()
    companies = [
        company
        for t in requested
        if _TICKER_RE.match(t) and (company := edgar.company_by_ticker(t)) is not None
    ][:MAX_TICKERS]

    results = await asyncio.gather(
        *(_entries(company) for company in companies), return_exceptions=True
    )
    entries: list[FeedEntry] = []
    failed = 0
    for company, result in zip(companies, results):
        if isinstance(result, httpx.HTTPError):
            # One filer's EDGAR failure costs its entries, not the whole feed.
            failed += 1
            logger.warning("Watchlist feed dropped %s", company.ticker, exc_info=result)
        elif isinstance(result, BaseException):
            raise result
        else:
            entries.extend(result)
    if companies and failed == len(companies):
        raise HTTPException(status_code=502, detail="Failed to fetch filings from EDGAR")

    kept = [company.ticker for company in companies]
    title = f"SECDigest watchlist: {', '.join(kept)}" if kept else "SECDigest watchlist"
    return _atom(
        render_atom(
            feed_id=make_feed_id(kept),
            title=title,
            self_url=str(request.url),
            alternate_url=f"{settings.frontend_url}/watchlist",
            site_url=settings.frontend_url,
            entries=newest_first(entries),
        )
    )


@router.get("/{ticker}.atom", response_class=Response, responses=_ATOM_RESPONSE)
@limiter.limit("30/minute")
async def company_feed(request: Request, response: Response, ticker: str):
    """A company's latest 10-K, 10-Q and 8-K filings, amendments included, newest first."""
    ticker = ticker.upper()
    if not _TICKER_RE.match(ticker):
        raise HTTPException(status_code=422, detail="Invalid ticker format")

    await _ensure_ticker_map()
    company = edgar.company_by_ticker(ticker)
    if company is None:
        raise HTTPException(status_code=404, detail="Company not found")

    try:
        entries = await _entries(company)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            raise HTTPException(status_code=404, detail="Company not found")
        raise HTTPException(status_code=502, detail="Failed to fetch filings from EDGAR")
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Failed to fetch filings from EDGAR")

    return _atom(
        render_atom(
            feed_id=make_feed_id([company.ticker]),
            title=f"{company.name} ({company.ticker}) filings",
            self_url=str(request.url),
            alternate_url=f"{settings.frontend_url}/company/{company.ticker}",
            site_url=settings.frontend_url,
            entries=newest_first(entries),
        )
    )
