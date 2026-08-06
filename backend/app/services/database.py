from __future__ import annotations

import asyncio

from postgrest.exceptions import APIError
from postgrest.types import CountMethod
from supabase import create_client, Client

from app.config import settings
from app.models.schemas import AnalysisResponse


_client: Client | None = None

_UNIQUE_VIOLATION = "23505"


def _get_client() -> Client:
    global _client
    if _client is None:
        _client = create_client(settings.supabase_url, settings.supabase_key)
    return _client


def _row_to_response(row: dict) -> AnalysisResponse:
    return AnalysisResponse(
        id=row["id"],
        accession_number=row["accession_number"],
        cik=row["cik"],
        ticker=row["ticker"],
        company_name=row["company_name"],
        form_type=row["form_type"],
        filing_date=row.get("filing_date"),
        revenue_current=row.get("revenue_current"),
        revenue_yoy_change_pct=row.get("revenue_yoy_change_pct"),
        net_income_current=row.get("net_income_current"),
        net_income_yoy_change_pct=row.get("net_income_yoy_change_pct"),
        risk_factors=row.get("risk_factors", []),
        management_guidance=row.get("management_guidance"),
        summary=row.get("summary"),
        created_at=row["created_at"],
    )


# The supabase client is synchronous — every call goes through asyncio.to_thread
# so it never blocks the event loop (backend/CLAUDE.md).

def _get_by_accession_sync(accession_number: str) -> AnalysisResponse | None:
    result = (
        _get_client()
        .table("analyses")
        .select("*")
        .eq("accession_number", accession_number)
        .limit(1)
        .execute()
    )
    if result.data:
        return _row_to_response(result.data[0])
    return None


async def get_by_accession(accession_number: str) -> AnalysisResponse | None:
    """Look up a cached analysis by accession number."""
    return await asyncio.to_thread(_get_by_accession_sync, accession_number)


def _create_analysis_sync(data: dict) -> AnalysisResponse:
    try:
        result = _get_client().table("analyses").insert(data).execute()
    except APIError as e:
        # Concurrent request analyzed the same filing first — return its row
        if getattr(e, "code", None) == _UNIQUE_VIOLATION:
            existing = _get_by_accession_sync(data["accession_number"])
            if existing:
                return existing
        raise
    return _row_to_response(result.data[0])


async def create_analysis(data: dict) -> AnalysisResponse:
    """Insert a new analysis row and return it (or the existing row on a
    concurrent duplicate insert)."""
    return await asyncio.to_thread(_create_analysis_sync, data)


def _get_by_id_sync(analysis_id: int) -> AnalysisResponse | None:
    result = (
        _get_client()
        .table("analyses")
        .select("*")
        .eq("id", analysis_id)
        .limit(1)
        .execute()
    )
    if result.data:
        return _row_to_response(result.data[0])
    return None


async def get_by_id(analysis_id: int) -> AnalysisResponse | None:
    """Get a single analysis by database ID."""
    return await asyncio.to_thread(_get_by_id_sync, analysis_id)


def _list_analyses_sync(
    limit: int, offset: int, ticker: str | None
) -> tuple[list[AnalysisResponse], int]:
    client = _get_client()

    count_query = client.table("analyses").select("id", count=CountMethod.exact)
    if ticker:
        count_query = count_query.eq("ticker", ticker)
    total = count_query.execute().count or 0

    query = client.table("analyses").select("*")
    if ticker:
        query = query.eq("ticker", ticker)
    result = (
        query.order("created_at", desc=True)
        .range(offset, offset + limit - 1)
        .execute()
    )

    analyses = [_row_to_response(row) for row in result.data]
    return analyses, total


async def list_analyses(
    limit: int = 20, offset: int = 0, ticker: str | None = None
) -> tuple[list[AnalysisResponse], int]:
    """List analyses ordered by creation date, optionally filtered by ticker."""
    return await asyncio.to_thread(_list_analyses_sync, limit, offset, ticker)
