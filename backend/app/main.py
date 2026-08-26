import logging
from contextlib import asynccontextmanager
from typing import cast

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from starlette.responses import Response

from app.config import settings
from app.middleware import (
    BodySizeLimitMiddleware,
    RequestIdLogFilter,
    RequestIdMiddleware,
    SecurityHeadersMiddleware,
)
from app import quota
from app.ratelimit import limiter
from app.routers import companies, filings, analysis, financials
from app.services import edgar

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(request_id)s] %(name)s: %(message)s",
)
for _handler in logging.getLogger().handlers:
    _handler.addFilter(RequestIdLogFilter())
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: load SEC ticker map into memory. The API must boot even if SEC
    # is briefly down — the search endpoint lazily retries the load.
    try:
        await edgar.load_tickers()
    except Exception:
        logger.warning("Ticker map load failed at startup; will retry lazily", exc_info=True)
    # The daily cap fails open, so a missing GRANT or a renamed RPC looks exactly
    # like normal operation at request time. One probe surfaces it in the boot log.
    try:
        await quota.probe()
    except Exception:
        logger.warning(
            "Daily quota RPC unavailable; the cap will run per-process until this is fixed",
            exc_info=True,
        )
    yield
    await edgar.close_client()


app = FastAPI(title="SECDigest API", version="1.0.0", lifespan=lifespan)

app.state.limiter = limiter


def _rate_limit_handler(request: Request, exc: Exception) -> Response:
    # slowapi's handler is typed narrowly; this shim satisfies starlette's
    # (Request, Exception) exception-handler contract
    return _rate_limit_exceeded_handler(request, cast(RateLimitExceeded, exc))


app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)

_origins = {settings.frontend_url}
if settings.frontend_url.startswith("http://localhost"):
    _origins.add("http://127.0.0.1:3000")

app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
    # Without this the browser hides every custom response header from the
    # frontend's JS, so the 429 countdown and the request ID are unreadable
    # cross-origin no matter what the backend sets.
    expose_headers=[
        "Retry-After",
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
        "X-RateLimit-Reset",
        "X-Request-ID",
    ],
)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(BodySizeLimitMiddleware)
# Added last → runs outermost, so every log line in the request path carries the ID
app.add_middleware(RequestIdMiddleware)

app.include_router(companies.router)
app.include_router(filings.router)
app.include_router(analysis.router)
app.include_router(financials.router)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.get("/api/health")
async def health():
    return {"status": "ok"}
