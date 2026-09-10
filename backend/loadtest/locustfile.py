"""Load profile for the SECDigest API (roadmap 5.7).

Three read paths, chosen because each exercises a different layer:

    /api/companies/search   in-memory ticker map, never leaves the process
    /api/filings/{cik}      filings_cache (TTL 900s), warmed by loadtest.warm
    /api/analysis?limit=20  Supabase, via asyncio.to_thread — the only uncached path

Every endpoint is rate limited per IP and slowapi keys on request.client.host, so 50
users from one machine would share one bucket and spend the run being 429ed. Each user
therefore sends its own synthetic X-Forwarded-For, and uvicorn must run with
`--proxy-headers --forwarded-allow-ips="*"` (what backend/Dockerfile already does in
production) for that header to reach the limiter. See loadtest/README.md.

    SHARED_IP=1   collapse every user onto one address, to measure the limiter itself
    ENABLE_POST=1 include POST /api/analysis, capped at MAX_POSTS for the whole run
"""

from __future__ import annotations

import itertools
import os
import random
import threading
from collections import Counter

from locust import HttpUser, between, events, task

from loadtest.targets import CIKS, SEARCH_PREFIXES

SHARED_IP = os.getenv("SHARED_IP") == "1"
ENABLE_POST = os.getenv("ENABLE_POST") == "1"
MAX_POSTS = 3

_SHARED_ADDRESS = "10.0.0.1"
_ip_counter = itertools.count(1)
_status_counts: Counter[str] = Counter()
_limit_headers: dict[str, set[str]] = {
    "Retry-After": set(),
    "X-RateLimit-Remaining": set(),
}
_post_lock = threading.Lock()
_posts_sent = 0


def _next_ip() -> str:
    """A distinct RFC 1918 address per user, or one shared address under SHARED_IP."""
    if SHARED_IP:
        return _SHARED_ADDRESS
    n = next(_ip_counter)
    return f"10.{(n >> 16) & 0xFF}.{(n >> 8) & 0xFF}.{n & 0xFF}"


def _claim_post_slot() -> bool:
    global _posts_sent
    with _post_lock:
        if _posts_sent >= MAX_POSTS:
            return False
        _posts_sent += 1
        return True


class SECDigestUser(HttpUser):
    # The per-IP limit on search and filings is 30/minute, so a user must stay under one
    # request every 2s or it 429s on its own budget and the throughput number becomes a
    # measurement of the limiter. between(2, 4) averages 20 requests/minute per user.
    wait_time = between(2, 4)

    def on_start(self) -> None:
        self.client.headers["X-Forwarded-For"] = _next_ip()
        self.filing = None
        if ENABLE_POST:
            self.filing = self._pick_filing()

    def _pick_filing(self) -> dict | None:
        """One already-analyzed filing, so POST returns the cached row instead of
        spending LLM quota. Deliberately not a fresh filing (see README)."""
        with self.client.get(
            f"/api/filings/{CIKS[0]}", name="/api/filings/[cik]", catch_response=True
        ) as response:
            if response.status_code != 200:
                return None
            filings = response.json()
        return filings[0] if filings else None

    def _record(self, response, expect_limit: bool) -> None:
        _status_counts[f"{response.request_meta['name']} {response.status_code}"] += 1
        if response.status_code == 429:
            # Sampled, not asserted: the run reports what the limiter actually sent so
            # the writeup quotes measured headers rather than the unit tests' fixtures.
            _limit_headers["Retry-After"].add(response.headers.get("Retry-After", "<absent>"))
            _limit_headers["X-RateLimit-Remaining"].add(
                response.headers.get("X-RateLimit-Remaining", "<absent>")
            )
        if response.status_code == 200:
            response.success()
        elif response.status_code == 429 and expect_limit:
            # Under SHARED_IP the 429 is the result being measured, not a failure.
            response.success()
        else:
            response.failure(f"HTTP {response.status_code}")

    @task(5)
    def search(self) -> None:
        query = random.choice(SEARCH_PREFIXES)
        with self.client.get(
            f"/api/companies/search?q={query}",
            name="/api/companies/search",
            catch_response=True,
        ) as response:
            self._record(response, SHARED_IP)

    @task(4)
    def filings(self) -> None:
        cik = random.choice(CIKS)
        with self.client.get(
            f"/api/filings/{cik}", name="/api/filings/[cik]", catch_response=True
        ) as response:
            self._record(response, SHARED_IP)

    # Weight 1 against 9: this is the only path that leaves the process, and it reaches
    # the live Supabase project. A tenth of the traffic still fills the thread pool.
    @task(1)
    def recent_analyses(self) -> None:
        with self.client.get(
            "/api/analysis?limit=20", name="/api/analysis", catch_response=True
        ) as response:
            self._record(response, SHARED_IP)

    # Weight 0 keeps it out of locust's weighted task list entirely, rather than
    # scheduling a no-op that would still burn a wait_time and skew the other weights.
    @task(1 if ENABLE_POST else 0)
    def create_analysis(self) -> None:
        if self.filing is None or not _claim_post_slot():
            return
        payload = {
            "accession_number": self.filing["accession_number"],
            "cik": CIKS[0],
            "ticker": "AAPL",
            "company_name": "Apple Inc.",
            "form_type": self.filing["form_type"],
            "filing_date": self.filing.get("filing_date"),
            "primary_document": self.filing["primary_document"],
        }
        with self.client.post(
            "/api/analysis", json=payload, name="/api/analysis [POST]", catch_response=True
        ) as response:
            self._record(response, SHARED_IP)


@events.quitting.add_listener
def _print_status_breakdown(environment, **kwargs) -> None:
    """Locust's own table collapses every non-2xx into "failures". The run needs the
    split, because a 429 is the expected result in one scenario and a bug in the other."""
    mode = "shared IP" if SHARED_IP else "distinct IPs"
    print(f"\nStatus breakdown ({mode}):")
    for key in sorted(_status_counts):
        print(f"  {key:<40} {_status_counts[key]:>6}")
    if ENABLE_POST:
        print(f"  POSTs sent: {_posts_sent}/{MAX_POSTS}")
    if any(_limit_headers.values()):
        print("\n429 headers observed:")
        for header, values in _limit_headers.items():
            print(f"  {header:<24} {sorted(values)}")
