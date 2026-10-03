"""Language drift between consecutive filings (roadmap 12.1). Pure: no I/O, so every rule here
is unit-tested directly. The router does the reads.

Thresholds come from `scripts/measure_drift.py` (2026-10-02, five same-company 10-Q pairs and
one cross-company control). The control's per-chunk best match tops out at p90 0.899, so a
passage scoring under NOVEL_THRESHOLD matches its own prior filing no better than unrelated
text does."""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

from app.models.schemas import AnalysisResponse

NOVEL_THRESHOLD = 0.90
MAX_NOVEL_PASSAGES = 5
EXCERPT_CHARS = 450
# A prior sentence this close (content-word ratio) to a changed one is its earlier wording; below
# it, the change has no counterpart and the old side is left empty rather than filled with
# something unrelated. Measured 2026-10-02: true rewordings 0.56-0.71, false matches 0.00-0.11.
_COUNTERPART_RATIO = 0.4

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


# Splits after . ! or ? when the next sentence opens with a capital, digit, quote or bracket.
_SENTENCE_END_RE = re.compile(r"(?<=[.!?])[\"”’)]?\s+(?=[A-Z0-9“\"(])")
# Tokens that end in a period without ending a sentence ("U.S. Treasury", "Apple Inc. and").
_CLOSED_RE = re.compile(r"[.!?][\"”’)]?$")
_INNER_END_RE = re.compile(r"[.!?][\"”’)]?(?=\s)")
_ABBREVIATIONS = ("U.S.", "Inc.", "No.", "Co.", "Corp.", "Ltd.", "Mr.", "Ms.", "Dr.", "e.g.", "i.e.", "vs.")


def _flat(text: str) -> str:
    return " ".join(text.split())


def sentences(text: str, starts_clean: bool = False) -> list[str]:
    """Whole sentences of a chunk. Chunks are fixed character windows, so the first piece is a
    fragment unless the chunk opens the filing (`starts_clean`), and a last piece with no closing
    punctuation is one too; both are dropped."""
    flat = _flat(text)
    pieces: list[str] = []
    start = 0
    for match in _SENTENCE_END_RE.finditer(flat):
        head = flat[start : match.start()].rstrip()
        if head.endswith(_ABBREVIATIONS):
            continue
        pieces.append(flat[start : match.end()].strip())
        start = match.end()
    pieces.append(flat[start:].strip())
    pieces = [p for p in pieces if p]
    if pieces and not starts_clean:
        pieces = pieces[1:]
    if pieces and not _CLOSED_RE.search(pieces[-1]):
        # A fragment that opens lowercase never split from the sentence before it; keep that
        # sentence and drop only the fragment.
        ends = list(_INNER_END_RE.finditer(pieces[-1]))
        head = pieces[-1][: ends[-1].end()] if ends else ""
        pieces = pieces[:-1] + ([head] if head and not head.endswith(_ABBREVIATIONS) else [])
    return pieces


def _fit(parts: list[str], limit: int) -> list[str]:
    """The leading parts whose joined length stays within `limit`, always at least one."""
    out: list[str] = []
    length = -1
    for part in parts:
        length += len(part) + 1
        if out and length > limit:
            break
        out.append(part)
    return out


def excerpt(parts: list[str], limit: int = EXCERPT_CHARS) -> str:
    """Whole sentences up to `limit`, always at least one. A single sentence longer than the
    limit is cut at a word boundary and marked with a trailing ellipsis."""
    out = " ".join(_fit(parts, limit))
    if len(out) <= limit:
        return out
    return out[:limit].rsplit(" ", 1)[0] + "…"


_WORD_RE = re.compile(r"[a-z0-9’']+")
# Function words, plus the stock ending of a risk factor ("could materially adversely affect the
# Company's business, results of operations, financial condition and stock price"). Kept in,
# that ending alone made two unrelated risks look like one reworded.
_FILLER = frozenset(
    "the a an and or of to in on for with by as at from that which this these those is are be "
    "been was were it its could would may can will has have had other such any company "
    "company’s company's business results operations financial condition stock price "
    "materially adversely adverse affect impact".split()
)


def _words(text: str) -> list[str]:
    return [w for w in _WORD_RE.findall(text.lower()) if w not in _FILLER]


def join_chunks(chunks: list[str]) -> str:
    """A filing's text rebuilt from its chunks, in order. Neighbours overlap by up to
    CHUNK_OVERLAP characters (less after strip), so each chunk is spliced in where its opening
    reappears near the end of the text so far; a sentence that straddles a boundary is then
    whole again, which no single chunk guarantees."""
    out = ""
    for chunk in chunks:
        flat = _flat(chunk)
        if not out:
            out = flat
            continue
        # A 60-character probe fits inside any overlap strip() leaves; 400 bounds the search.
        at = out.find(flat[:60], max(0, len(out) - 400))
        out = out[:at] + flat if at != -1 else f"{out} {flat}"
    return out


@dataclass(frozen=True)
class Comparison:
    excerpt: str
    prior_excerpt: str | None


def compare(new_text: str, prior_text: str, starts_clean: bool = False) -> Comparison | None:
    """The changed wording in a passage and the prior filing's closest wording to it.

    `prior_text` is the whole prior filing (`join_chunks`), not just the passage the embeddings
    matched: text that moved to another section is not new, and only the full text can say so.
    None when every whole sentence also appears in the prior filing; the passage then differs only
    in a fragment at its edges, which is nothing a reader can be shown."""
    current = sentences(new_text, starts_clean)
    changed = [i for i, sentence in enumerate(current) if sentence not in prior_text]
    if not changed:
        return None

    # The longest run of consecutive changed sentences is the change; a stray reworded clause
    # elsewhere in the window is not.
    runs: list[list[int]] = []
    for i in changed:
        if runs and runs[-1][-1] == i - 1:
            runs[-1].append(i)
        else:
            runs.append([i])
    run = max(runs, key=lambda r: sum(len(current[i]) for i in r))
    # Only what fits is shown, and only what is shown gets a counterpart: the old side must
    # answer the sentences the reader can see, not ones cut from the excerpt.
    shown = _fit([current[i] for i in run], EXCERPT_CHARS)

    # Content words, not characters: two unrelated risk sentences sharing the stock ending
    # scored 0.52 on characters against 0.61 for a true rewording; on content words, 0.00 and 0.61.
    prior = sentences(prior_text, starts_clean=True)
    prior_words = [_words(p) for p in prior]
    counterparts: set[int] = set()
    for sentence in shown:
        words = _words(sentence)
        best, best_ratio = None, _COUNTERPART_RATIO
        for j, old in enumerate(prior_words):
            matcher = SequenceMatcher(None, words, old, autojunk=False)
            if matcher.quick_ratio() < best_ratio:
                continue
            ratio = matcher.ratio()
            if ratio >= best_ratio:
                best, best_ratio = j, ratio
        if best is not None:
            counterparts.add(best)

    return Comparison(
        excerpt=excerpt(shown),
        prior_excerpt=excerpt([prior[j] for j in sorted(counterparts)]) if counterparts else None,
    )


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
