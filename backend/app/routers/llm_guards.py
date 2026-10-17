"""HTTP mapping for the shared Gemini budget, used by every route that calls the LLM.

Both raise `HTTPException`, never a bare LLM error, so the streaming analysis path
re-emits them as `error` frames with the same status the JSON path returns."""

import logging
from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import HTTPException

from app import quota
from app.services.llm import LLMError, LLMQuotaError

logger = logging.getLogger(__name__)


async def require_quota() -> None:
    """Spend one unit of today's analysis budget, or 503 when it is spent."""
    if not await quota.try_consume():
        raise HTTPException(
            status_code=503,
            detail="Daily analysis capacity reached — try again tomorrow",
            headers={"Retry-After": "3600"},
        )


@contextmanager
def llm_errors(failure: str, *args: object) -> Iterator[None]:
    """Map a Gemini quota hit to 503 and any other LLM failure to 502.
    `failure` and `args` are the warning logged before the 502."""
    try:
        yield
    except LLMQuotaError:
        raise HTTPException(
            status_code=503,
            detail="Analysis service is at capacity — try again in a minute",
            headers={"Retry-After": "60"},
        )
    except LLMError:
        logger.warning(failure, *args, exc_info=True)
        raise HTTPException(status_code=502, detail="LLM analysis failed")
