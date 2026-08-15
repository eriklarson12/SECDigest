import contextvars
import logging
import re
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.config import settings

logger = logging.getLogger(__name__)

# Correlates interleaved Heroku log lines from concurrent requests.
request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "request_id", default="-"
)
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9\-]{8,64}$")


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        supplied = request.headers.get("X-Request-ID", "")
        request_id = supplied if _REQUEST_ID_RE.match(supplied) else uuid.uuid4().hex[:12]
        token = request_id_var.set(request_id)
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        response.headers["X-Request-ID"] = request_id
        return response


class RequestIdLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        return True

_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
}

# JSON API — nothing should ever execute or embed it. Swagger UI (/docs, /redoc)
# loads its assets from a CDN, so the strict CSP applies to /api paths only.
_API_CSP = "default-src 'none'; frame-ancestors 'none'"


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        for name, value in _SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        if request.url.path.startswith("/api"):
            response.headers.setdefault("Content-Security-Policy", _API_CSP)
        return response


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    """Reject oversized request bodies before they are read.
    Chunked requests without a Content-Length are rejected outright so the cap can't be bypassed."""

    async def dispatch(self, request: Request, call_next):
        if request.method in ("POST", "PUT", "PATCH"):
            content_length = request.headers.get("content-length")
            if content_length is None:
                if request.headers.get("transfer-encoding", "").lower() == "chunked":
                    return JSONResponse(
                        status_code=411, content={"detail": "Content-Length required"}
                    )
            else:
                try:
                    length = int(content_length)
                except ValueError:
                    return JSONResponse(
                        status_code=400, content={"detail": "Invalid Content-Length"}
                    )
                if length > settings.max_request_bytes:
                    return JSONResponse(
                        status_code=413, content={"detail": "Request body too large"}
                    )
        return await call_next(request)
