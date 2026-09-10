"""Fixed targets shared by the warmer and the load profile.

CIKs are large, long-established filers already in the corpus. The set is fixed and
small on purpose: EDGAR fair access (docs/edgar.md) forbids pointing concurrent load at
cold CIKs, so the warmer fetches these eight once and every subsequent request in the
run is served from filings_cache.
"""

CIKS = [
    "320193",   # AAPL
    "789019",   # MSFT
    "77476",    # PEP
    "18230",    # CAT
    "63908",    # MCD
    "27419",    # TGT
    "37996",    # F
    "12927",    # BA
]

# Prefixes, not whole tickers: search matches on prefix and a 1-3 char query is the
# realistic keystroke pattern, which is also the widest fan-out over the ticker map.
SEARCH_PREFIXES = [
    "a", "ap", "app", "m", "ms", "msf", "t", "tg", "tgt",
    "c", "ca", "cat", "f", "b", "ba", "pe", "pep", "mc",
]
