"""Read the revenue breakdown (roadmap 12.8) for analyses stored before it was recorded.
Lives outside tests/ — writes to the live database, manual only, never CI. Spends no LLM quota:
one throttled EDGAR submissions read per company, one filing download per analysis, one UPDATE each.

Only rows whose `segments` is NULL are read, because NULL means "never computed" and a computed
empty result is stored as a breakdown with no splits. Rerunning is cheap; `--all` reads every row."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from app.services import database, edgar, segments
from scripts.backfill_flags import _by_company, _load_candidates

logger = logging.getLogger("backfill-segments")


async def backfill(ticker: str | None, limit: int | None, dry_run: bool, every_row: bool) -> int:
    rows = await _load_candidates(ticker)
    if not every_row:
        rows = [row for row in rows if row.segments is None]
    if limit is not None:
        rows = rows[:limit]
    if not rows:
        logger.info("No analyses to read.")
        return 0

    logger.info("%d analyses to read", len(rows))

    failures = 0
    with_breakdown = 0
    for cik, company_rows in _by_company(rows).items():
        try:
            filings = await edgar.get_filings(
                cik, form_types=edgar.ANALYZED_FORM_TYPES, limit=edgar.SUBMISSIONS_LIMIT
            )
        except Exception:
            logger.warning("CIK %s: EDGAR submissions read failed", cik, exc_info=True)
            failures += len(company_rows)
            continue

        for row in company_rows:
            label = f"{row.ticker} {row.form_type} {row.accession_number}"
            document = edgar.find_primary_document(row.accession_number, filings)
            if document is None:
                logger.warning("%s: no longer listed in EDGAR, skipped", label)
                failures += 1
                continue

            try:
                html = await edgar.fetch_filing_html(cik, row.accession_number, document)
                result = segments.parse_segments(html, row.form_type, label)
            except Exception:
                logger.warning("%s: download or parse failed", label, exc_info=True)
                failures += 1
                continue

            found = [
                f"{name} ({len(split.rows)})"
                for name, split in (("segments", result.segments), ("geography", result.geography))
                if split is not None
            ]
            if found:
                with_breakdown += 1
            summary = ", ".join(found) or "none"

            if dry_run:
                logger.info("%s: would write %s", label, summary)
                continue

            try:
                await database.set_segments(row.id, result)
            except Exception:
                logger.warning("%s: update failed", label, exc_info=True)
                failures += 1
                continue
            logger.info("%s: %s", label, summary)

    logger.info("%d of %d analyses carry a breakdown", with_breakdown, len(rows))
    if failures:
        logger.warning("%d analyses failed — rerun to retry", failures)
        return 1
    return 0


async def _run(ticker: str | None, limit: int | None, dry_run: bool, every_row: bool) -> int:
    """There's no app lifespan here, so close the shared EDGAR client by hand."""
    try:
        return await backfill(ticker, limit, dry_run, every_row)
    finally:
        await edgar.close_client()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ticker", help="Only read this ticker")
    parser.add_argument("--limit", type=int, help="Stop after N analyses")
    parser.add_argument(
        "--all", action="store_true", help="Reread rows that already carry a breakdown"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would be written, without updating any row (reads EDGAR, writes nothing)",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    try:
        return asyncio.run(
            _run(
                ticker=args.ticker.upper() if args.ticker else None,
                limit=args.limit,
                dry_run=args.dry_run,
                every_row=args.all,
            )
        )
    except KeyboardInterrupt:
        logger.warning("Interrupted — analyses already read are kept.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
