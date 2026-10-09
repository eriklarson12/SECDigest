from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import TypeVar

Row = TypeVar("Row")

# Roadmap 13.2: K stays at the per-filing ask's 6, and no filing may supply more than half,
# so a "how has X changed" question always sees at least two filings when two are indexed.
COMPANY_K = 6
PER_FILING = 3
MAX_FILINGS = 6


def select_balanced(
    rows: Sequence[Row],
    filing_of: Callable[[Row], str],
    similarity_of: Callable[[Row], float],
    k: int = COMPANY_K,
    per_filing: int = PER_FILING,
) -> list[Row]:
    """The global top `k` by similarity, skipping a row once its filing already holds `per_filing`.
    Shared by the company ask and the Q&A eval, so the eval measures the rule the app runs."""
    taken: dict[str, int] = {}
    picked: list[Row] = []
    for row in sorted(rows, key=similarity_of, reverse=True):
        filing = filing_of(row)
        if taken.get(filing, 0) >= per_filing:
            continue
        taken[filing] = taken.get(filing, 0) + 1
        picked.append(row)
        if len(picked) == k:
            break
    return picked
