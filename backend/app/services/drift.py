"""Language drift between consecutive filings (roadmap 12.1). Pure: no I/O, so every rule here
is unit-tested directly. The router does the reads.

Thresholds come from `scripts/measure_drift.py` (2026-10-02, five same-company 10-Q pairs and
one cross-company control). The control's per-chunk best match tops out at p90 0.899, so a
passage scoring under NOVEL_THRESHOLD matches its own prior filing no better than unrelated
text does."""

from __future__ import annotations

import re

from app.models.schemas import AnalysisResponse

NOVEL_THRESHOLD = 0.90
MAX_NOVEL_PASSAGES = 5
EXCERPT_CHARS = 300

# Tables measured 0.14-0.33 digits per non-space character, prose 0.00-0.11. A table whose
# figures moved scores low on embeddings without saying anything new.
_TABLE_DIGIT_RATIO = 0.12
# Form furniture that changes only in dates and names each quarter. Digit ratio misses it:
# a cover page or signature block runs under 0.06.
_BOILERPLATE_RE = re.compile(
    r"I\.R\.S\. Employer Identification"
    r"|duly authorized"
    r"|Exhibit Number"
    r"|Certification of .{0,80}pursuant to",
    re.IGNORECASE,
)


def digit_ratio(text: str) -> float:
    chars = [c for c in text if not c.isspace()]
    return sum(c.isdigit() for c in chars) / len(chars) if chars else 0.0


def is_boilerplate(text: str) -> bool:
    return digit_ratio(text) > _TABLE_DIGIT_RATIO or bool(_BOILERPLATE_RE.search(text))


def excerpt(text: str, limit: int = EXCERPT_CHARS) -> str:
    """Whitespace-collapsed, cut at a word boundary. Chunks are fixed character windows, so
    the leading ellipsis is always honest: a chunk rarely starts at a sentence."""
    flat = " ".join(text.split())
    if len(flat) <= limit:
        return f"…{flat}"
    cut = flat[:limit].rsplit(" ", 1)[0]
    return f"…{cut}…"


def pick_prior(
    analysis: AnalysisResponse, history: list[AnalysisResponse]
) -> AnalysisResponse | None:
    """The stored analysis of the same form filed most recently before `analysis`.

    MUST agree with `findPriorAnalysis` in frontend/src/lib/riskDiff.ts, including the tie:
    on equal filing dates the first in `history` order wins. Both are pinned to
    tests/fixtures/prior_analysis.json."""
    if not analysis.filing_date:
        return None
    prior: AnalysisResponse | None = None
    for candidate in history:
        if candidate.accession_number == analysis.accession_number:
            continue
        if candidate.form_type != analysis.form_type:
            continue
        if not candidate.filing_date or candidate.filing_date >= analysis.filing_date:
            continue
        if prior is None or candidate.filing_date > (prior.filing_date or ""):
            prior = candidate
    return prior


def novel_indexes(rows: list[dict]) -> list[int]:
    """Chunk indexes under the threshold, lowest similarity first."""
    below = [r for r in rows if r["max_similarity"] < NOVEL_THRESHOLD]
    below.sort(key=lambda r: r["max_similarity"])
    return [r["chunk_index"] for r in below]
