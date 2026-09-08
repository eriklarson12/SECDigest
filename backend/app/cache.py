"""Tiny in-memory TTL cache for EDGAR-derived responses.
Single dyno makes in-memory correct (same reasoning as app/quota.py) — no external deps or threads."""

from __future__ import annotations

import time
from typing import Any


class TTLCache:
    def __init__(self, ttl_seconds: int, max_entries: int) -> None:
        self._ttl = ttl_seconds
        self._max = max_entries
        # dict preserves insertion order — oldest-inserted is evicted first
        self._data: dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> Any | None:
        item = self._data.get(key)
        if item is None:
            return None
        inserted_at, value = item
        if time.monotonic() - inserted_at > self._ttl:
            del self._data[key]
            return None
        return value

    def set(self, key: str, value: Any) -> None:
        if key in self._data:
            del self._data[key]
        elif len(self._data) >= self._max:
            del self._data[next(iter(self._data))]
        self._data[key] = (time.monotonic(), value)

    def clear(self) -> None:
        """Test hook (reset in tests/conftest.py)."""
        self._data.clear()


filings_cache = TTLCache(ttl_seconds=900, max_entries=500)
financials_cache = TTLCache(ttl_seconds=3600, max_entries=500)
# Holds the parsed CompanyProfile, never the submissions body it came from: those run to
# 4.4 MB decompressed for a prolific filer like JPM, and 500 of them would not fit the dyno.
# A day is safe — a filer's SIC changes on the order of never.
profile_cache = TTLCache(ttl_seconds=86_400, max_entries=500)
# Keyed on the padded SIC, holding the intersected and ranked peer list — never the ~90 KB of
# XML per page it came from. A day is safe for the same reason profile_cache is, and the long
# TTL is what keeps a six-page feed scan inside SEC fair access.
peers_cache = TTLCache(ttl_seconds=86_400, max_entries=200)
# Fallback documents for EDGAR's companyconcept fault: some filers answer 200 with no facts at all
# while companyfacts holds them (see _has_no_facts). One entry is ~5 MB parsed, so this stays tiny —
# it only has to outlive the concept fetches of a single request, and financials_cache covers the
# repeat visit for an hour after that.
company_facts_cache = TTLCache(ttl_seconds=600, max_entries=2)
# Population frames from the XBRL frames API (roadmap 9.4). A closed period's frame never changes,
# so a day is conservative. Holds the sorted values + a cik map, never the parsed body: the
# NetIncomeLoss CY2025 frame is 3,286 KB of Python objects that way and 752 KB this way (measured).
# One period fills 10 entries: 7 concept frames, the 2 merged multi-concept metrics, and the
# resolved period itself. ~6 MB at ~0.7 MB a frame, and 24 leaves room to cross a period rollover
# without evicting a live frame on a 512 MB dyno.
frames_cache = TTLCache(ttl_seconds=86_400, max_entries=24)
