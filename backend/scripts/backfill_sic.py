"""Stamp the SEC industry classification (roadmap 8.1) onto analyses stored before the columns existed.
Lives outside tests/ — writes to the live database, manual only, never CI. Spends no LLM quota:
one throttled EDGAR read per distinct company, then one UPDATE each."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from app.models.schemas import AnalysisResponse
from app.services import database, edgar

logger = logging.getLogger("backfill-sic")

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


def _companies_needing_profile(
    rows: list[AnalysisResponse], force: bool
) -> dict[str, str]:
    """CIK -> ticker for the companies still to stamp.

    Keyed by CIK because the classification belongs to the filer: 67 analyses cover 50
    companies, and fetching per filing would pay for the same answer twice."""
    pending: dict[str, str] = {}
    for row in rows:
        if not force and row.sic:
            continue
        pending.setdefault(row.cik, row.ticker)
    return pending


async def backfill(ticker: str | None, limit: int | None, force: bool, dry_run: bool) -> int:
    rows = await _load_candidates(ticker)
    if not rows:
        logger.info("No stored analyses to backfill.")
        return 0

    pending = _companies_needing_profile(rows, force)
    if not pending:
        logger.info("Every stored analysis already carries a classification.")
        return 0

    companies = list(pending.items())
    if limit is not None:
        companies = companies[:limit]

    logger.info("%d company/companies to classify (%d analyses stored)", len(companies), len(rows))

    failures = 0
    for cik, tk in companies:
        try:
            profile = await edgar.get_company_profile(cik)
        except Exception:
            logger.warning("%s (CIK %s): EDGAR lookup failed", tk, cik, exc_info=True)
            failures += 1
            continue

        if profile.sic is None:
            # Not a failure: EDGAR leaves a good share of filers unclassified.
            logger.info("%s (CIK %s): no classification in EDGAR — leaving NULL", tk, cik)
            continue

        if dry_run:
            logger.info(
                "%s (CIK %s): would set %s / %s / %s",
                tk, cik, profile.sic, profile.sic_description, profile.owner_org,
            )
            continue

        try:
            updated = await database.set_company_profile(cik, profile)
        except Exception:
            logger.warning("%s (CIK %s): update failed", tk, cik, exc_info=True)
            failures += 1
            continue

        logger.info(
            "%s (CIK %s): %s — %s [%s], %d row(s)",
            tk, cik, profile.sic, profile.sic_description, profile.owner_org, updated,
        )

    if failures:
        logger.warning("%d company/companies failed — rerun to retry just those", failures)
        return 1
    return 0


async def _run(ticker: str | None, limit: int | None, force: bool, dry_run: bool) -> int:
    """There's no app lifespan here, so close the shared EDGAR client by hand."""
    try:
        return await backfill(ticker, limit, force, dry_run)
    finally:
        await edgar.close_client()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ticker", help="Only backfill this ticker")
    parser.add_argument("--limit", type=int, help="Stop after N companies")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-fetch companies that already carry a classification (EDGAR reassigned a SIC)",
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
                force=args.force,
                dry_run=args.dry_run,
            )
        )
    except KeyboardInterrupt:
        logger.warning("Interrupted — companies already stamped are kept.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
