"""Build the per-filing centroids language peers rank on (roadmap 9.1), for analyses stored
before filing_vectors existed. Lives outside tests/ — writes to the live database, manual only,
never CI.

Spends no quota of any kind: no Gemini, and no EDGAR either. Note the imports below — this is the
one backfill script that opens no HTTP client at all, because the averaging happens inside Postgres
over embeddings that were already paid for. Safe to re-run; every write is an upsert."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from app.models.schemas import AnalysisResponse
from app.services import database

logger = logging.getLogger("backfill-vectors")

_PAGE_SIZE = 100


async def _load_candidates(ticker: str | None) -> list[AnalysisResponse]:
    """Every stored analysis, oldest page first."""
    rows: list[AnalysisResponse] = []
    offset = 0

    while True:
        page, total = await database.list_analyses(
            limit=_PAGE_SIZE, offset=offset, ticker=ticker
        )
        if not page:
            break
        rows.extend(page)
        offset += len(page)
        if offset >= total:
            break

    return rows


async def backfill(
    ticker: str | None,
    limit: int | None,
    force: bool,
    include_partial: bool,
    dry_run: bool,
) -> int:
    rows = await _load_candidates(ticker)
    if not rows:
        logger.info("No stored analyses to backfill.")
        return 0

    # One read for the whole table rather than one per filing: the corpus is small, but asking
    # 74 times for an answer that arrives once is the kind of thing that stops being small.
    stored = await database.filing_vector_counts()

    if limit is not None:
        rows = rows[:limit]

    written = 0
    current = 0
    failures = 0
    outstanding: list[str] = []

    for row in rows:
        label = f"{row.ticker} {row.form_type} ({row.accession_number})"

        try:
            indexed = await database.chunk_count(row.accession_number)
        except Exception:
            logger.warning("%s — chunk count failed", label, exc_info=True)
            failures += 1
            continue

        if not indexed:
            logger.warning("%s — no chunks stored, cannot build a centroid", label)
            outstanding.append(f"{row.ticker} {row.form_type}")
            continue

        # A centroid averaged over part of a filing misrepresents it to every other filing in
        # the corpus, so a short index is skipped rather than approximated.
        short = row.chunks_expected is not None and indexed < row.chunks_expected
        if short and not include_partial:
            logger.warning(
                "%s — PARTIAL: %d/%d chunks. Complete it with scripts/backfill_chunks.py, "
                "or pass --include-partial to accept it as is.",
                label,
                indexed,
                row.chunks_expected,
            )
            outstanding.append(f"{row.ticker} {row.form_type}")
            continue

        if stored.get(row.accession_number) == indexed and not force:
            current += 1
            continue

        if dry_run:
            logger.info("%s — would build a centroid over %d chunks", label, indexed)
            written += 1
            continue

        try:
            chunks = await database.upsert_filing_vector(row.accession_number)
        except Exception:
            logger.warning("%s — centroid write failed", label, exc_info=True)
            failures += 1
            continue

        logger.info("%s — centroid over %d chunks", label, chunks)
        written += 1

    verb = "Would build" if dry_run else "Built"
    logger.info(
        "%s %d centroid(s); %d already current, %d outstanding, %d failed.%s",
        verb,
        written,
        current,
        len(outstanding),
        failures,
        " Nothing was written." if dry_run else "",
    )
    if outstanding:
        logger.info("Left without a centroid: %s", ", ".join(outstanding))

    return 1 if outstanding or failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ticker", help="Only backfill this ticker")
    parser.add_argument("--limit", type=int, help="Stop after N analyses")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Recompute centroids that already match the filing's stored chunk count",
    )
    parser.add_argument(
        "--include-partial",
        action="store_true",
        help="Build a centroid for a filing whose index is short (separate from --force: it "
        "accepts incomplete language rather than redoing current work)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report which centroids would be built, without writing any (reads only)",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    try:
        return asyncio.run(
            backfill(
                ticker=args.ticker.upper() if args.ticker else None,
                limit=args.limit,
                force=args.force,
                include_partial=args.include_partial,
                dry_run=args.dry_run,
            )
        )
    except KeyboardInterrupt:
        logger.warning("Interrupted — centroids already written are kept.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
