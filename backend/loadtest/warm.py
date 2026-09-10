"""Prime filings_cache before a load run (roadmap 5.7).

Without this the first request for each CIK goes to EDGAR, and 50 concurrent users would
measure SEC's latency plus the throttle in services/edgar.py rather than this API. One
sequential pass costs eight EDGAR requests total; filings_cache holds them for 900s.

Run from backend/:  python -m loadtest.warm
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.error
import urllib.request

from loadtest.targets import CIKS

# Its own bucket, so warming never spends the rate-limit budget of a user in the run.
WARM_IP = "10.255.255.254"


def _get(host: str, path: str) -> tuple[int, float]:
    request = urllib.request.Request(
        f"{host}{path}", headers={"X-Forwarded-For": WARM_IP}
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            response.read()
            status = response.status
    except urllib.error.HTTPError as exc:
        status = exc.code
    return status, (time.perf_counter() - started) * 1000


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="http://localhost:8000")
    args = parser.parse_args()

    print(f"Warming {len(CIKS)} CIKs against {args.host}\n")
    failures = 0
    for cik in CIKS:
        cold_status, cold_ms = _get(args.host, f"/api/filings/{cik}")
        warm_status, warm_ms = _get(args.host, f"/api/filings/{cik}")
        ok = cold_status == 200 and warm_status == 200
        failures += 0 if ok else 1
        print(
            f"  {cik:>10}  cold {cold_status} {cold_ms:7.1f}ms"
            f"   warm {warm_status} {warm_ms:7.1f}ms"
            f"   {'' if ok else '  <-- FAILED'}"
        )

    # The second call proving faster than the first is the whole point: it is the only
    # evidence that the run measures the cache path and not EDGAR.
    print(f"\n{len(CIKS) - failures}/{len(CIKS)} warmed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
