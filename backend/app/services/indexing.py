"""Background filing indexing for Q&A (roadmap 5.1): chunks and embeds after `POST /analysis` returns, via a FastAPI BackgroundTask.
One process-wide `_pacer` + `_lock` serialize jobs against Gemini's shared rate window — coordinates within a process only, so `Dockerfile` pins `--workers 1`."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, replace

from app.services import database, embeddings

logger = logging.getLogger(__name__)

# The four states the Ask card renders. "complete" means every chunk landed; a run that
# stored some but not all is "partial" and says so, because an index missing two-thirds of
# a filing still answers questions — confidently, from the third it has.
INDEXING = "indexing"
COMPLETE = "complete"
PARTIAL = "partial"
UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class IndexStatus:
    state: str
    chunks_indexed: int
    chunks_total: int


_pacer = embeddings.TokenPacer()
_lock = asyncio.Lock()
_status: dict[str, IndexStatus] = {}


def reset() -> None:
    """Clear process state — test seam, since these singletons outlive a test."""
    global _pacer, _lock
    _status.clear()
    _pacer = embeddings.TokenPacer()
    _lock = asyncio.Lock()


def mark_scheduled(accession_number: str, chunks_total: int) -> None:
    """Record a filing as queued *before* the response returns.
    BackgroundTasks only start once the response is sent; without this the first poll would wrongly report "unavailable"."""
    _status[accession_number] = IndexStatus(INDEXING, 0, chunks_total)


async def run_index(accession_number: str, filing_text: str) -> None:
    """Index one filing to completion. Never raises — nobody is listening.
    Serialized on `_lock` and paced by `_pacer`; `resume=True` tops up a filing left partial by an earlier attempt."""
    async with _lock:
        try:
            await embeddings.index_filing(
                accession_number, filing_text, pacer=_pacer, resume=True
            )
        except Exception:
            logger.warning(
                "Background indexing failed for %s", accession_number, exc_info=True
            )

        # The DB, not the return value, decides the outcome: a run that failed
        # halfway still leaves answerable chunks behind.
        try:
            indexed = await database.chunk_count(accession_number)
        except Exception:
            logger.warning(
                "Could not read chunk count for %s", accession_number, exc_info=True
            )
            return

    record = _status.get(accession_number)
    total = record.chunks_total if record else indexed
    # Any stored chunk makes the filing answerable, so the card stops waiting either way.
    # A short index is a backfill job, not a reason to poll forever — but it is reported
    # as partial rather than complete, so the gap is visible instead of implied.
    state = COMPLETE if indexed >= total else (PARTIAL if indexed else UNAVAILABLE)
    _status[accession_number] = IndexStatus(state, indexed, total)

    if not indexed:
        logger.warning("Indexed 0 chunks for %s — Q&A unavailable", accession_number)
    elif indexed < total:
        logger.warning(
            "Partial index for %s: %d/%d chunks — run scripts/backfill_chunks.py",
            accession_number,
            indexed,
            total,
        )
    else:
        logger.info("Indexed %d chunks for %s", indexed, accession_number)


async def status_for(
    accession_number: str, chunks_expected: int | None = None
) -> IndexStatus:
    """Coverage for one filing; the stored chunk count is the source of truth.
    `chunks_expected` is the analyses row's durable total — pass it so coverage survives the
    restart that clears `_status`, which otherwise reports a partial index as 24 of 24."""
    indexed = await database.chunk_count(accession_number)
    record = _status.get(accession_number)

    if record is not None and record.state == INDEXING:
        return replace(record, chunks_indexed=indexed)

    # Nothing scheduled in this process: a pre-feature analysis, or one whose record a restart
    # cleared. Fall back to the stored total; without one, what's indexed is all we can claim.
    total = record.chunks_total if record is not None else (chunks_expected or indexed)
    if not indexed:
        return IndexStatus(UNAVAILABLE, 0, total)
    return IndexStatus(COMPLETE if indexed >= total else PARTIAL, indexed, total)
