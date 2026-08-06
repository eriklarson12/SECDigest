"""Tiny in-memory TTL cache for EDGAR-derived responses.

Filing lists and XBRL facts change at most a few times a quarter per company;
caching them cuts latency and keeps us politer to SEC. Single dyno → in-memory
is correct (same reasoning as app/quota.py). No external deps, no threads.
"""

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
