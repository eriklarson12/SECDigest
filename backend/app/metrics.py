"""Prometheus metrics (roadmap 17.2), served by `GET /metrics` behind `METRICS_TOKEN`.

One process, `--workers 1`, so the default registry is the whole picture and no multiprocess mode
is needed. Every label set here MUST stay bounded: a label that takes a CIK or a raw path makes one
series per company, the same mistake as slowapi's `key_style="url"` (roadmap 10.1)."""

from __future__ import annotations

import time
from collections.abc import Iterable

from prometheus_client import Counter, Histogram
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# An analysis is an EDGAR fetch plus a Gemini call, 10 to 60 s cold, so the default buckets'
# 10 s ceiling would put every cold analysis in +Inf.
HTTP_REQUEST_DURATION = Histogram(
    "http_request_duration_seconds",
    "Time from request start to the last response byte.",
    ["method", "route", "status"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60),
)

# One increment per attempt, because each attempt is a request SEC counts against fair access.
# `status` keeps 403 and 429 apart from other 4xx: those two are SEC's block signals, while a
# 404 is routine (frames answer 404 for an untagged concept).
EDGAR_REQUESTS = Counter(
    "edgar_requests",
    "EDGAR HTTP attempts by outcome and final status.",
    ["outcome", "status"],
)

EDGAR_PACE_WAIT = Histogram(
    "edgar_pace_wait_seconds",
    "Time a request waited for its pacing slot before going to SEC.",
    buckets=(0, 0.01, 0.05, 0.125, 0.25, 0.5, 1, 2, 5, 10, 30),
)

LLM_REQUESTS = Counter(
    "llm_requests",
    "Gemini generate calls by model and outcome.",
    ["model", "outcome"],
)

ANALYSIS_CACHE = Counter(
    "analysis_cache",
    "POST /api/analysis lookups of the accession number.",
    ["result"],
)

UNMATCHED_ROUTE = "unmatched"

EDGAR_OUTCOMES = ("ok", "retried", "failed")
EDGAR_STATUSES = ("2xx", "3xx", "4xx", "403", "429", "5xx", "transport")

# A labelled series exists only after its first increment, and `increase()` cannot see the step
# from absent to 1. Without these zeros the first 429 of a process's life never fires EdgarBlocked.
for _outcome in EDGAR_OUTCOMES:
    for _status in EDGAR_STATUSES:
        EDGAR_REQUESTS.labels(outcome=_outcome, status=_status)
for _result in ("hit", "miss"):
    ANALYSIS_CACHE.labels(result=_result)


def prime_routes(routes: Iterable[object]) -> None:
    """Export a zero 200 series per route, so the first request on a route, usually its cold
    and slowest one, is visible to `increase()` rather than founding the series."""
    for route in routes:
        path = _template(route)
        for method in getattr(route, "methods", None) or ():
            if path is not None and method != "HEAD":
                HTTP_REQUEST_DURATION.labels(method=method, route=path, status="200")


def edgar_status(status_code: int | None) -> str:
    """The `status` label for one EDGAR attempt; None is a transport error."""
    if status_code is None:
        return "transport"
    if status_code in (403, 429):
        return str(status_code)
    return f"{status_code // 100}xx"


def _template(route: object) -> str | None:
    path = getattr(route, "path_format", None) or getattr(route, "path", None)
    return path if isinstance(path, str) else None


def _route(scope: Scope) -> str:
    return _template(scope.get("route")) or UNMATCHED_ROUTE


class MetricsMiddleware:
    """Times every HTTP request to its last body byte, labelled by route template.

    Pure ASGI rather than `BaseHTTPMiddleware`: the analysis stream is an SSE response, and a
    `BaseHTTPMiddleware` timer stops when headers go out, minutes before the stream ends. The route
    is read after the app returns, because routing writes `scope["route"]` on the way in."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        status = 500
        start = time.perf_counter()

        async def send_wrapper(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            HTTP_REQUEST_DURATION.labels(
                method=scope["method"], route=_route(scope), status=str(status)
            ).observe(time.perf_counter() - start)
