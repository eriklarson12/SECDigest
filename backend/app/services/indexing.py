"""Background filing indexing for Q&A (roadmap 5.1).

`POST /analysis` returns as soon as the analysis row is stored; chunking and
embedding run afterwards as a FastAPI BackgroundTask. Nothing on a request path
waits for the free-tier 30k tokens/minute embedding cap, and a filing reaches
*full* coverage instead of the front ~24 chunks one inline batch could afford.

Two module-level singletons hold the invariant:

- `_pacer` — one TokenPacer for the whole process, so every embedding request
  is metered against the same rolling window Gemini meters the project against.
- `_lock` — index jobs run one at a time. Without it two jobs would interleave
  batches inside one minute's budget and stall each other in `pacer.acquire`.

Together they fix the collision the inline indexer had: two analyses a minute
apart used to leave the second filing with zero chunks, because one inline batch
spent ~27k of the 30k window. Now both return instantly and their jobs queue.

Both singletons coordinate *within a process only*, which is why
`backend/Dockerfile` pins `--workers 1` — see the comment there before changing
it. Question embedding on the /ask path is deliberately left unpaced: a question
is ~200 tokens against 3k of headroom under the cap, and answers must stay fast.

Durability (accepted, not solved): a dyno restart or deploy kills in-flight
indexing and clears `_status`, leaving a filing partially indexed.
`scripts/backfill_chunks.py` resumes by stored chunk count, so the next backfill
run completes it. The database is the durable record — `_status` only remembers
how many chunks a filing is *aiming* for, which the DB can't tell us.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, replace

from app.services import database, embeddings

logger = logging.getLogger(__name__)

# The three states the Ask card renders. "complete" means indexing finished, not
# that every chunk landed — compare chunks_indexed to chunks_total for that.
INDEXING = "indexing"
COMPLETE = "complete"
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

    BackgroundTasks only start once the response is sent, so without this the
    Ask card's first poll would find no record and report "unavailable" for a
    filing that is about to be indexed.
    """
    _status[accession_number] = IndexStatus(INDEXING, 0, chunks_total)


async def run_index(accession_number: str, filing_text: str) -> None:
    """Index one filing to completion. Never raises — nobody is listening.

    Serialized on `_lock` and paced by `_pacer`; `resume=True` means a filing
    left partial by an earlier attempt is topped up rather than re-embedded.
    """
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
    # Any stored chunk makes the filing answerable, so the card stops waiting.
    # A short index is a backfill job, not a reason to poll forever.
    state = COMPLETE if indexed else UNAVAILABLE
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


async def status_for(accession_number: str) -> IndexStatus:
    """Coverage for one filing; the stored chunk count is the source of truth."""
    indexed = await database.chunk_count(accession_number)
    record = _status.get(accession_number)
    if record is None:
        # Nothing scheduled in this process: an analysis from before this
        # feature, or one whose record a restart cleared. What's stored is all
        # we can honestly claim.
        return IndexStatus(COMPLETE if indexed else UNAVAILABLE, indexed, indexed)
    return replace(record, chunks_indexed=indexed)
