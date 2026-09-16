"""Burst the uncached DB read path at fixed concurrency levels (roadmap 10.2).

Roadmap 5.7 found `GET /api/analysis` degrading roughly linearly with concurrency and
recorded the table in loadtest/README.md. That table was produced by hand, and 10.2's
acceptance is re-running it, so the harness lives here instead.

    --target api      N concurrent GET /api/analysis?limit=20 against a local uvicorn
    --target direct   the same burst against PostgREST, bypassing FastAPI entirely

`direct` is the diagnosis. Each variant changes exactly one thing about the transport,
so the shape of the curve says which layer serializes:

    supabase-shared    one create_client(), N threads          production today
    supabase-h1        the same, with an injected HTTP/1.1 client
    httpx-h2           one shared httpx.Client(http2=True)      protocol, no supabase-py
    httpx-h1           one shared httpx.Client(http2=False)     protocol changed, sharing kept
    httpx-per-thread   a fresh client per thread, HTTP/2        sharing removed, protocol kept

If the h2 arms degrade and the h1 arms do not, the bottleneck is HTTP/2 multiplexing every
request onto one TCP connection, where httpcore's sync read lock makes threads take turns.
If every arm degrades, including per-thread, it is Supabase's side and no client change helps.

Reads only. Never writes, and never prints the key.

Run from backend/:  python -m loadtest.burst --target api
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
import urllib.error
import urllib.request
from typing import Callable

LEVELS = [1, 5, 10, 20, 40]
ROUNDS = 3

# GET /api/analysis is limited to 60/minute per IP per endpoint, and a full run sends
# (1+5+10+20+40) x 3 = 228 requests. A distinct synthetic address per *request* keeps every
# bucket empty, so the run measures the API rather than slowapi. uvicorn only honours the
# header with `--proxy-headers --forwarded-allow-ips="*"` — see README.md.
_ip_lock = threading.Lock()
_ip_counter = 0


def _next_ip() -> str:
    global _ip_counter
    with _ip_lock:
        _ip_counter += 1
        n = _ip_counter
    return f"10.{(n >> 16) & 0xFF}.{(n >> 8) & 0xFF}.{n & 0xFF}"


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(0, min(len(ordered) - 1, round(pct / 100 * len(ordered) + 0.5) - 1))
    return ordered[rank]


def burst(call: Callable[[], None], concurrency: int, rounds: int) -> list[float]:
    """Fire `concurrency` calls as simultaneously as threads allow, `rounds` times.

    The barrier matters: without it the threads start staggered by their own spawn cost and
    a level of 40 never actually has 40 requests in flight.
    """
    samples: list[float] = []
    errors: list[str] = []

    for _ in range(rounds):
        barrier = threading.Barrier(concurrency)
        round_samples: list[float] = []
        lock = threading.Lock()

        def worker() -> None:
            barrier.wait()
            started = time.perf_counter()
            try:
                call()
            except Exception as exc:  # noqa: BLE001 — the run reports failures, never hides them
                with lock:
                    errors.append(f"{type(exc).__name__}: {exc}")
                return
            elapsed = (time.perf_counter() - started) * 1000
            with lock:
                round_samples.append(elapsed)

        threads = [threading.Thread(target=worker) for _ in range(concurrency)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        samples.extend(round_samples)

    if errors:
        print(f"    {len(errors)} failed: {sorted(set(errors))[:3]}")
    return samples


def run_table(label: str, call: Callable[[], None], rounds: int) -> None:
    print(f"\n{label}")
    print(f"  {'concurrency':>11}  {'n':>4}  {'p50':>9}  {'p95':>9}  {'max':>9}")
    for level in LEVELS:
        samples = burst(call, level, rounds)
        if not samples:
            print(f"  {level:>11}  {0:>4}  {'—':>9}  {'—':>9}  {'—':>9}")
            continue
        print(
            f"  {level:>11}  {len(samples):>4}"
            f"  {_percentile(samples, 50):>7.1f}ms"
            f"  {_percentile(samples, 95):>7.1f}ms"
            f"  {max(samples):>7.1f}ms"
        )


# --- target: api -------------------------------------------------------------------

def _api_call(host: str) -> Callable[[], None]:
    def call() -> None:
        request = urllib.request.Request(
            f"{host}/api/analysis?limit=20", headers={"X-Forwarded-For": _next_ip()}
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            response.read()
            if response.status != 200:
                raise RuntimeError(f"HTTP {response.status}")

    return call


# --- target: direct ----------------------------------------------------------------

# The same page the API asks for, so the two targets are comparable. Deliberately one query
# and not the count-plus-rows pair production sends: the diagnosis is about the transport,
# and one request per thread is the cleanest way to read the curve.
_SELECT = "select=*&order=created_at.desc&limit=20"


def _direct_calls(variant: str) -> Callable[[], None]:
    import httpx
    from supabase import create_client, ClientOptions

    from app.config import settings

    rest_url = f"{settings.supabase_url}/rest/v1"
    headers = {
        "apikey": settings.supabase_key,
        "Authorization": f"Bearer {settings.supabase_key}",
    }
    limits = httpx.Limits(max_connections=64, max_keepalive_connections=64)

    if variant == "supabase-shared":
        client = create_client(settings.supabase_url, settings.supabase_key)

        def call() -> None:
            client.table("analyses").select("*").order(
                "created_at", desc=True
            ).range(0, 19).execute()

    elif variant == "supabase-h1":
        http_client = httpx.Client(
            base_url=rest_url, http2=False, follow_redirects=True, limits=limits
        )
        client = create_client(
            settings.supabase_url,
            settings.supabase_key,
            options=ClientOptions(httpx_client=http_client),
        )

        def call() -> None:
            client.table("analyses").select("*").order(
                "created_at", desc=True
            ).range(0, 19).execute()

    elif variant in ("httpx-h2", "httpx-h1"):
        shared = httpx.Client(
            base_url=rest_url,
            headers=headers,
            http2=variant == "httpx-h2",
            limits=limits,
            timeout=30.0,
        )

        def call() -> None:
            response = shared.get(f"/analyses?{_SELECT}")
            response.raise_for_status()

    elif variant == "httpx-per-thread":

        def call() -> None:
            with httpx.Client(
                base_url=rest_url, headers=headers, http2=True, timeout=30.0
            ) as client:
                response = client.get(f"/analyses?{_SELECT}")
                response.raise_for_status()

    else:
        raise ValueError(f"unknown variant {variant!r}")

    return call


VARIANTS = [
    "supabase-shared",
    "supabase-h1",
    "httpx-h2",
    "httpx-h1",
    "httpx-per-thread",
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=["api", "direct"], default="api")
    parser.add_argument("--variant", default="all", help=f"one of {VARIANTS}, or 'all'")
    parser.add_argument("--host", default="http://localhost:8000")
    parser.add_argument("--rounds", type=int, default=ROUNDS)
    args = parser.parse_args()

    if args.target == "api":
        print(f"GET /api/analysis?limit=20 against {args.host}, {args.rounds} rounds per level")
        try:
            _api_call(args.host)()
        except (urllib.error.URLError, RuntimeError) as exc:
            print(f"\nCannot reach {args.host}: {exc}")
            print("Start it with the command in loadtest/README.md.")
            return 1
        run_table("through the API", _api_call(args.host), args.rounds)
        return 0

    variants = VARIANTS if args.variant == "all" else [args.variant]
    print(f"PostgREST directly, {args.rounds} rounds per level")
    for variant in variants:
        run_table(variant, _direct_calls(variant), args.rounds)
    return 0


if __name__ == "__main__":
    sys.exit(main())
