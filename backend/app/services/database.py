from __future__ import annotations

import asyncio
from typing import cast

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
        return _row_to_response(cast(dict, result.data[0]))
    return None


async def get_by_accession(accession_number: str) -> AnalysisResponse | None:
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
    return _row_to_response(cast(dict, result.data[0]))


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
        return _row_to_response(cast(dict, result.data[0]))
    return None


async def get_by_id(analysis_id: int) -> AnalysisResponse | None:
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

    analyses = [_row_to_response(cast(dict, row)) for row in result.data]
    return analyses, total


async def list_analyses(
    limit: int = 20, offset: int = 0, ticker: str | None = None
) -> tuple[list[AnalysisResponse], int]:
    """List analyses ordered by creation date, optionally filtered by ticker."""
    return await asyncio.to_thread(_list_analyses_sync, limit, offset, ticker)


# --- Filing chunks (Q&A retrieval, roadmap 5.1): embeddings cross the wire as JSON arrays;
# "[0.1,0.2,…]" is pgvector's own text input format, so the VECTOR(768) cast needs no client-side encoding.

def _insert_chunks_sync(
    accession_number: str, chunks: list[tuple[int, str, list[float]]]
) -> None:
    rows = [
        {
            "accession_number": accession_number,
            "chunk_index": index,
            "content": content,
            "embedding": embedding,
        }
        for index, content, embedding in chunks
    ]
    try:
        _get_client().table("filing_chunks").insert(rows).execute()
    except APIError as e:
        # A concurrent request indexed the same filing first — its rows are
        # equivalent, so treat the unique violation as success.
        if getattr(e, "code", None) == _UNIQUE_VIOLATION:
            return
        raise


async def insert_chunks(
    accession_number: str, chunks: list[tuple[int, str, list[float]]]
) -> None:
    """Bulk-insert (chunk_index, content, embedding) rows for one filing."""
    if not chunks:
        return
    await asyncio.to_thread(_insert_chunks_sync, accession_number, chunks)


def _chunk_count_sync(accession_number: str) -> int:
    result = (
        _get_client()
        .table("filing_chunks")
        .select("id", count=CountMethod.exact)
        .eq("accession_number", accession_number)
        .limit(1)
        .execute()
    )
    return result.count or 0


async def chunk_count(accession_number: str) -> int:
    """Doubles as the resume point for a partial index and as the durable
    source of truth behind GET /analysis/{id}/index-status."""
    return await asyncio.to_thread(_chunk_count_sync, accession_number)


# PostgREST's `or_` filter spells its wildcard `*`, unlike the `.ilike()` method,
# which takes `%`. With `%` here the filter parses fine and matches nothing.
_SCALE_FILTER = (
    "content.ilike.*in millions*,"
    "content.ilike.*in thousands*,"
    "content.ilike.*in billions*"
)


def _find_scale_chunks_sync(
    accession_number: str, near_chunk_index: int, limit: int
) -> list[str]:
    client = _get_client()

    def query(descending: bool, before: int | None):
        q = (
            client.table("filing_chunks")
            .select("content")
            .eq("accession_number", accession_number)
            .or_(_SCALE_FILTER)
        )
        if before is not None:
            q = q.lte("chunk_index", before)
        return q.order("chunk_index", desc=descending).limit(limit).execute()

    result = query(descending=True, before=near_chunk_index)
    if not result.data:
        # The chunk sits above every declaration — fall back to the filing's first.
        result = query(descending=False, before=None)
    return [cast(dict, row)["content"] for row in result.data]


async def find_scale_chunks(
    accession_number: str, near_chunk_index: int, limit: int = 3
) -> list[str]:
    """Chunks that declare a unit scale, nearest at-or-above the given index first.
    Prefilter only — `services/units.py` decides which is a real declaration."""
    return await asyncio.to_thread(
        _find_scale_chunks_sync, accession_number, near_chunk_index, limit
    )


def _match_chunks_sync(
    accession_number: str, embedding: list[float], k: int
) -> list[dict]:
    result = (
        _get_client()
        .rpc(
            "match_chunks",
            {
                "p_accession": accession_number,
                "p_embedding": embedding,
                "p_k": k,
            },
        )
        .execute()
    )
    return cast(list[dict], result.data or [])


async def match_chunks(
    accession_number: str, embedding: list[float], k: int = 6
) -> list[dict]:
    """Nearest chunks for one filing by cosine distance (pgvector `<=>`)."""
    return await asyncio.to_thread(_match_chunks_sync, accession_number, embedding, k)
