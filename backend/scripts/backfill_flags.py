"""Scan analyses stored before red flags (roadmap 12.4) for going-concern doubt and material weakness.
Lives outside tests/ — writes to the live database, manual only, never CI. Spends no LLM quota:
one throttled EDGAR submissions read per company, one filing download per analysis, one UPDATE each.

Every row is scanned, not only empty ones: '[]' is both the column default and the honest
result for a clean filing, so the two cannot be told apart. Rerunning is safe."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from collections import defaultdict

from app.models.schemas import AnalysisResponse
from app.services import database, edgar, red_flags

logger = logging.getLogger("backfill-flags")

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


def _by_company(rows: list[AnalysisResponse]) -> dict[str, list[AnalysisResponse]]:
    """Grouped so a company's submissions feed, which holds every document path, is read once."""
    grouped: dict[str, list[AnalysisResponse]] = defaultdict(list)
    for row in rows:
        grouped[row.cik].append(row)
    return grouped


async def backfill(ticker: str | None, limit: int | None, dry_run: bool) -> int:
    rows = await _load_candidates(ticker)
    if limit is not None:
        rows = rows[:limit]
    if not rows:
        logger.info("No stored analyses to scan.")
        return 0

    logger.info("%d analyses to scan", len(rows))

    failures = 0
    flagged = 0
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
                text = await edgar.fetch_filing_plain_text(cik, row.accession_number, document)
            except Exception:
                logger.warning("%s: filing download failed", label, exc_info=True)
                failures += 1
                continue

            flags = red_flags.detect_text_flags(
                text, row.form_type, row.filing_date, row.accession_number
            )
            if flags:
                flagged += 1
            kinds = ", ".join(f.kind for f in flags) or "none"

            if dry_run:
                logger.info("%s: would write %s", label, kinds)
                for flag in flags:
                    logger.info("    %s: %s", flag.kind, flag.excerpt)
                continue

            try:
                await database.set_flags(row.id, flags)
            except Exception:
                logger.warning("%s: update failed", label, exc_info=True)
                failures += 1
                continue
            logger.info("%s: %s", label, kinds)

    logger.info("%d of %d analyses carry a flag", flagged, len(rows))
    if failures:
        logger.warning("%d analyses failed — rerun to retry", failures)
        return 1
    return 0


async def _run(ticker: str | None, limit: int | None, dry_run: bool) -> int:
    """There's no app lifespan here, so close the shared EDGAR client by hand."""
    try:
        return await backfill(ticker, limit, dry_run)
    finally:
        await edgar.close_client()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ticker", help="Only scan this ticker")
    parser.add_argument("--limit", type=int, help="Stop after N analyses")
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
            )
        )
    except KeyboardInterrupt:
        logger.warning("Interrupted — analyses already scanned are kept.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
