"""Global daily budget for LLM analyses.
Unlike the per-IP rate limit, this protects the shared Gemini quota from distributed traffic.
Postgres-backed since roadmap 3.3: Heroku cycles dynos about daily, and an in-process counter
reset on every cycle, so the effective cap ran to roughly twice DAILY_ANALYSIS_CAP."""

import datetime
import logging

from app.config import settings
from app.services import database

logger = logging.getLogger(__name__)

_count = 0
_day: datetime.date | None = None


def _consume_in_memory(today: datetime.date) -> bool:
    """Fallback counter — process-local, so it resets on restart."""
    global _count, _day
    if _day != today:
        _day = today
        _count = 0
    if _count >= settings.daily_analysis_cap:
        return False
    _count += 1
    return True


async def try_consume() -> bool:
    """Reserve one analysis from today's budget; False when exhausted."""
    today = datetime.datetime.now(datetime.timezone.utc).date()
    try:
        return await database.increment_daily_usage(today, settings.daily_analysis_cap)
    except Exception:
        # Fail open: a quota-table hiccup must not cost an analysis. The cap
        # degrades to per-process for as long as the DB is unreachable.
        logger.warning("Daily quota RPC failed; falling back to the in-memory cap", exc_info=True)
        return _consume_in_memory(today)


async def probe() -> None:
    """Startup check that the RPC exists and is permitted.
    Fail-open makes a missing GRANT or a renamed function indistinguishable from normal operation at
    request time, so it is worth one call at boot. The sentinel day keeps it out of today's budget."""
    await database.increment_daily_usage(datetime.date.min, 0)


def reset() -> None:
    """Test hook — in-memory fallback state only."""
    global _count, _day
    _count = 0
    _day = None
