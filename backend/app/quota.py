"""Global daily budget for LLM analyses.
Unlike the per-IP rate limit, this protects the shared Gemini quota from distributed traffic; in-memory is fine on one dyno."""

import datetime

from app.config import settings

_count = 0
_day: datetime.date | None = None


def try_consume() -> bool:
    """Reserve one analysis from today's budget; False when exhausted."""
    global _count, _day
    today = datetime.datetime.now(datetime.timezone.utc).date()
    if _day != today:
        _day = today
        _count = 0
    if _count >= settings.daily_analysis_cap:
        return False
    _count += 1
    return True


def reset() -> None:
    """Test hook."""
    global _count, _day
    _count = 0
    _day = None
