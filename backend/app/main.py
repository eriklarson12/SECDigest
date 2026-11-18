import hmac
import logging
from contextlib import asynccontextmanager
from typing import cast

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from starlette.responses import Response

from app.config import settings
from app.logsetup import configure_logging
from app.metrics import MetricsMiddleware, prime_routes
from app.middleware import (
    BodySizeLimitMiddleware,
    RequestIdMiddleware,
    SecurityHeadersMiddleware,
)
from app import quota
from app.ratelimit import limiter
from app.routers import companies, filings, analysis, feeds, financials
from app.services import edgar

configure_logging()
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
app.add_middleware(RequestIdMiddleware)
# Added last → runs outermost, so a 413 or a 429 refused before routing is still timed
app.add_middleware(MetricsMiddleware)

_ROUTERS = (companies.router, filings.router, analysis.router, financials.router, feeds.router)
for _router in _ROUTERS:
    app.include_router(_router)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/metrics", include_in_schema=False)
async def metrics(request: Request) -> Response:
    """Prometheus exposition text. A 404 when the token is unset or wrong, so the route is not
    discoverable; not under /api, so the strict API CSP does not apply to it."""
    token = settings.metrics_token
    supplied = request.headers.get("authorization", "")
    if not token or not hmac.compare_digest(supplied.encode(), f"Bearer {token}".encode()):
        raise HTTPException(status_code=404, detail="Not Found")
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


# The routers' own lists, not just app.routes: FastAPI wraps an included router in a lazy
# _IncludedRouter whose routes app.routes does not list.
prime_routes([*app.routes, *(route for router in _ROUTERS for route in router.routes)])
