"""Unit-scale detection for Q&A answers (roadmap 5.1).

A filing declares its scale once, in a statement or MD&A header — "(amounts in
millions, except per share data)" — and then never repeats it beside the figures.
Retrieval returns the prose that answers the question, which almost never carries
that header, so an otherwise correct answer quotes "$11,133" without knowing it
means $11.1 billion.

This module finds the declaration that *governs* a retrieved chunk. The exceptions
matter as much as the unit: "except per share data" is what stops an answer from
reporting a $1.30 dividend as $1.30 million, so the phrase is carried through
verbatim rather than normalized down to "millions".
"""

from __future__ import annotations

import logging
import re

from app.services import database


logger = logging.getLogger(__name__)

# How many declaring chunks to pull before giving up. More than one because the
# SQL prefilter matches "in millions" anywhere in a chunk, which includes prose
# that isn't a declaration; the parse below is what decides.
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

    Pure — no I/O. Returns None when the chunk mentions a scale word without
    actually declaring one.
    """
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

    A header governs the section that follows it, so the nearest declaration at or
    above the chunk wins: for an MD&A liquidity answer that resolves to the MD&A
    header, not the income statement's, and the two differ in their exceptions.
    Chunks above the filing's first declaration fall back to it.

    Never raises. The caption is a nicety — a failed lookup must not cost the user
    an answer they already spent quota on.
    """
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
