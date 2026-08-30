"""Repair Q&A indexes that never finished (roadmap 5.1): tops up filings analyzed before Q&A shipped or left partial by a restart.
Lives outside tests/ — spends real Gemini embedding quota, manual only, never CI; paces against the same 30k tokens/minute cap as live indexing, so run it when the app is idle."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from app.models.schemas import AnalysisResponse, Filing
from app.services import database, edgar, embeddings

logger = logging.getLogger("backfill")

_PAGE_SIZE = 100

# Token pacing inside index_filing already spaces requests against the 30k/minute
# cap, so no extra delay between filings is needed by default.
_DEFAULT_SLEEP = 0.0


async def _load_candidates(ticker: str | None, limit: int | None) -> list[AnalysisResponse]:
    """Stored analyses to check, oldest first.
    Deliberately doesn't filter on "has any chunks" — a partially indexed filing is exactly the one worth topping up; completeness is decided per filing once the text is in hand."""
    candidates: list[AnalysisResponse] = []
    offset = 0

    while True:
        page, total = await database.list_analyses(
            limit=_PAGE_SIZE, offset=offset, ticker=ticker
        )
        if not page:
            break

        for row in page:
            candidates.append(row)
            if limit is not None and len(candidates) >= limit:
                return candidates

        offset += len(page)
        if offset >= total:
            break

    return candidates


async def backfill(ticker: str | None, limit: int | None, sleep: float, dry_run: bool) -> int:
    candidates = await _load_candidates(ticker, limit)
    if not candidates:
        logger.info("Nothing to backfill — every stored analysis already has chunks.")
        return 0

    logger.info("%d filing(s) to check", len(candidates))

    # One pacer for the whole run: the 30k/minute cap is per project, not per
    # filing, so the window has to carry across filings.
    pacer = embeddings.TokenPacer()
    submissions: dict[str, list[Filing]] = {}
    indexed = 0
    skipped = 0
    failed = 0
    remaining: list[str] = []
    short: list[str] = []

    for position, row in enumerate(candidates):
        label = f"{row.ticker} {row.form_type} ({row.accession_number})"
        try:
            if row.cik not in submissions:
                submissions[row.cik] = await edgar.get_filings(
                    row.cik,
                    form_types=edgar.ANALYZED_FORM_TYPES,
                    limit=edgar.SUBMISSIONS_LIMIT,
                )

            # The pure matcher, so this keeps reusing one submissions fetch per company.
            document = edgar.find_primary_document(
                row.accession_number, submissions[row.cik]
            )
            if document is None:
                logger.warning("%s — not in EDGAR's recent filings, skipping", label)
                failed += 1
                continue

            filing_text = await edgar.fetch_filing_text(
                cik=row.cik,
                accession_number=row.accession_number,
                primary_document=document,
            )
            if not filing_text.strip():
                logger.warning("%s — filing text was empty, skipping", label)
                failed += 1
                continue

            expected = len(embeddings.chunk_text(filing_text))
            existing = await database.chunk_count(row.accession_number)
            if existing >= expected:
                logger.info("%s — already complete (%d chunks)", label, existing)
                skipped += 1
                continue

            if dry_run:
                # Report only. Knowing a filing is short means knowing its real chunk
                # total, which only the filing text can give — hence the EDGAR fetch.
                # No embeddings and no writes, so no quota is spent either way.
                logger.warning(
                    "%s — SHORT: %d/%d chunks (%d missing)",
                    label,
                    existing,
                    expected,
                    expected - existing,
                )
                short.append(f"{row.ticker} {row.form_type} (id={row.id})")
                continue

            logger.info("%s — %d/%d chunks stored, indexing the rest", label, existing, expected)
            if expected != row.chunks_expected:
                await database.set_chunks_expected(row.accession_number, expected)
            stored = await embeddings.index_filing(
                row.accession_number, filing_text, pacer=pacer, resume=True
            )
            if existing + stored >= expected:
                logger.info("%s — complete at %d chunks", label, existing + stored)
                indexed += 1
            else:
                logger.warning(
                    "%s — still partial: %d/%d chunks", label, existing + stored, expected
                )
                failed += 1

        except embeddings.EmbeddingRequestQuotaError:
            # The daily cap counts one request per *chunk*, so it's spent for the day regardless of batching —
            # grinding on would add ~2 doomed retries per remaining filing (a real run wasted 30).
            remaining = [
                f"{later.ticker} {later.form_type}" for later in candidates[position:]
            ]
            logger.error(
                "%s — daily embedding request quota exhausted. Stopping with "
                "%d filing(s) unfinished; chunks already stored are kept.",
                label,
                len(remaining),
            )
            break

        except Exception:
            logger.exception("%s — failed", label)
            failed += 1

        if sleep > 0 and position < len(candidates) - 1:
            await asyncio.sleep(sleep)

    if dry_run:
        logger.info(
            "Dry run: %d short, %d already complete, %d unreadable, %d total. Nothing was spent.",
            len(short),
            skipped,
            failed,
            len(candidates),
        )
        if short:
            logger.info("Would index: %s", ", ".join(short))
        return 1 if short or failed else 0

    logger.info(
        "Done: %d indexed, %d already complete, %d failed, %d total",
        indexed,
        skipped,
        failed,
        len(candidates),
    )
    if remaining:
        logger.info(
            "Not attempted (quota): %s. Re-run after the daily reset — each "
            "filing resumes from its stored chunk count.",
            ", ".join(remaining),
        )
    return 1 if failed or remaining else 0


async def _run(ticker: str | None, limit: int | None, sleep: float, dry_run: bool) -> int:
    """There's no app lifespan here, so close the shared EDGAR client by hand."""
    try:
        return await backfill(ticker, limit, sleep, dry_run)
    finally:
        await edgar.close_client()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ticker", help="Only backfill this ticker")
    parser.add_argument("--limit", type=int, help="Stop after N filings")
    parser.add_argument(
        "--sleep",
        type=float,
        default=_DEFAULT_SLEEP,
        help=f"Extra seconds between filings on top of token pacing (default {_DEFAULT_SLEEP:g})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report which filings are short, without embedding anything (reads EDGAR, spends no Gemini quota)",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    try:
        return asyncio.run(
            _run(
                ticker=args.ticker.upper() if args.ticker else None,
                limit=args.limit,
                sleep=args.sleep,
                dry_run=args.dry_run,
            )
        )
    except KeyboardInterrupt:
        logger.warning("Interrupted — filings already indexed are kept.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
