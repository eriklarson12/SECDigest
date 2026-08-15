"""Unit-scale detection for Q&A answers (roadmap 5.1): filings declare scale once (e.g. "in millions") and never repeat it beside figures, so retrieval alone can't tell "$11,133" from $11.1 billion.
Finds the declaration governing a retrieved chunk; exceptions like "except per share data" are carried verbatim, never normalized."""

from __future__ import annotations

import logging
import re

from app.services import database


logger = logging.getLogger(__name__)

# How many declaring chunks to pull before giving up. More than one because the SQL prefilter matches
# "in millions" anywhere in a chunk, including non-declaring prose; the parse below decides.
_CANDIDATES = 3

# The declaration as filings actually write it: a parenthetical. Bounded and
# newline-free so an unrelated "(" earlier in the chunk can't swallow half a page.
_PARENTHETICAL_RE = re.compile(
    r"\(\s*([^()\n]{0,200}?\bin (?:thousands|millions|billions)\b[^()\n]{0,200}?)\s*\)",
    re.I,
)
# Prose fallback for filings that state it in a sentence. The leading noun is
# required: a bare "in millions" also matches "one in millions of shoppers".
_PROSE_RE = re.compile(
    r"\b((?:amounts|dollars|figures|numbers)\s+(?:are\s+)?"
    r"(?:expressed\s+|stated\s+|presented\s+)?in\s+"
    r"(?:thousands|millions|billions))\b",
    re.I,
)


def extract_scale(text: str) -> str | None:
    """The scale declaration inside one chunk, as a display-ready sentence.
    Pure — no I/O. Returns None when the chunk mentions a scale word without actually declaring one."""
    for pattern in (_PARENTHETICAL_RE, _PROSE_RE):
        match = pattern.search(text)
        if match:
            # Filing text arrives with the source document's line breaks still in
            # it, so collapse whitespace before this becomes a one-line caption.
            phrase = " ".join(match.group(1).split()).rstrip(" .,;:")
            return phrase[0].upper() + phrase[1:] + "."
    return None


async def scale_for(accession_number: str, near_chunk_index: int) -> str | None:
    """The scale governing `near_chunk_index`, or None if the filing never says.
    Nearest declaration at-or-above wins (so an MD&A answer gets the MD&A header, not the income statement's); never raises — a failed lookup mustn't cost an already-paid-for answer."""
    try:
        candidates = await database.find_scale_chunks(
            accession_number, near_chunk_index, _CANDIDATES
        )
    except Exception:
        logger.warning("Scale lookup failed for %s", accession_number, exc_info=True)
        return None

    for content in candidates:
        scale = extract_scale(content)
        if scale:
            return scale
    return None
