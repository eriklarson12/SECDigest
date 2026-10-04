"""Red flags read from a filing's own text (roadmap 12.4): going-concern doubt and a material
weakness in internal control. Pure, no I/O. Event flags (8-K 4.01/4.02, NT filings) come from the
submissions feed and are computed by the frontend.

Precision over recall: a false red flag on a healthy company is worse than a missed one, so a
sentence must state the condition, not raise it as a risk. Measured on the golden filings plus
known positives before shipping (tasks/roadmap.md, 12.4)."""

from __future__ import annotations

import re

from app.models.schemas import FlagKind, RedFlag
from app.services import drift
from app.services.edgar import _SEP, _find_section

_EXCERPT = 300

_GOING_CONCERN_RE = re.compile(r"substantial\s+doubt", re.I)
_GOING_CONCERN_TERM_RE = re.compile(r"going\s+concern", re.I)
# Risk factors and accounting-policy notes mention the condition without stating it.
_HYPOTHETICAL_RE = re.compile(
    r"\b(could|may|might|would|if|whether|unless|no substantial doubt|not raise|"
    r"alleviat\w*|evaluat\w*|assess\w*)\b",
    re.I,
)

def _spaced(word: str) -> str:
    # Text extraction puts a newline between inline tags, so a styled heading can split mid-word:
    # Turtle Beach's FY2025 10-K reads "Item 9A - Contro\nls and Procedures".
    return r"\s?".join(word)


# Item 9A in a 10-K, Part I Item 4 in a 10-Q. `_find_section` takes the last start match, which
# skips the table of contents.
_CONTROLS = rf"{_spaced('control')}s?\s+(?:and\s+)?{_spaced('procedures')}"
_CONTROLS_START_RE = {
    "10-K": re.compile(rf"item{_SEP}9a{_SEP}{_CONTROLS}", re.I),
    "10-Q": re.compile(rf"item{_SEP}4{_SEP}{_CONTROLS}", re.I),
}
_CONTROLS_END_RE = {
    "10-K": re.compile(r"item\s*9b\b", re.I),
    "10-Q": re.compile(r"part\s+ii\b|item\s*1\b", re.I),
}
_WEAKNESS_RE = re.compile(r"material\s+weakness", re.I)
_WEAKNESS_STATED_RE = re.compile(
    r"\b(identified\s+(?:a|two|three|several|the\s+following)?\s*material\s+weakness|"
    r"material\s+weakness(?:es)?\s+(?:that\s+|which\s+)?(?:exist|existed|exists)|"
    r"not\s+effective)\b",
    re.I,
)
# Also rejected: the auditor's scope boilerplate ("assessing the risk that a material weakness
# exists", in every large filer's 9A) and a prior year's weakness since remediated.
_WEAKNESS_NEGATED_RE = re.compile(
    r"\b(no\s+material\s+weakness|not\s+identif\w*|did\s+not|were\s+no|is\s+a\s+deficiency|"
    r"could|may|might|would|if|risk\s+that|previously|remediat\w*)\b",
    re.I,
)


def _excerpt(sentence: str) -> str:
    return sentence if len(sentence) <= _EXCERPT else sentence[:_EXCERPT].rstrip() + "…"


def going_concern_sentence(text: str) -> str | None:
    for sentence in drift.sentences(text, starts_clean=True):
        if not (_GOING_CONCERN_RE.search(sentence) and _GOING_CONCERN_TERM_RE.search(sentence)):
            continue
        if _HYPOTHETICAL_RE.search(sentence):
            continue
        return sentence
    return None


def material_weakness_sentence(text: str, form_type: str) -> str | None:
    base = form_type.removesuffix("/A")
    if base not in _CONTROLS_START_RE:
        return None
    start_re = _CONTROLS_START_RE[base]
    span = _find_section(text, start_re, _CONTROLS_END_RE[base])
    if span is None:
        return None
    # The heading has no full stop and would open the first sentence's excerpt.
    section = text[span[0] : span[1]]
    heading = start_re.match(section)
    section = section[heading.end() :] if heading else section
    for sentence in drift.sentences(section, starts_clean=True):
        if not _WEAKNESS_RE.search(sentence):
            continue
        if _WEAKNESS_NEGATED_RE.search(sentence) or not _WEAKNESS_STATED_RE.search(sentence):
            continue
        return sentence
    return None


def detect_text_flags(
    text: str, form_type: str, filed_date: str | None, accession_number: str
) -> list[RedFlag]:
    flags: list[RedFlag] = []
    found: tuple[tuple[FlagKind, str | None], ...] = (
        ("going_concern", going_concern_sentence(text)),
        ("material_weakness", material_weakness_sentence(text, form_type)),
    )
    for kind, sentence in found:
        if sentence is not None:
            flags.append(
                RedFlag(
                    kind=kind,
                    filed_date=filed_date,
                    accession_number=accession_number,
                    form_type=form_type,
                    excerpt=_excerpt(sentence),
                )
            )
    return flags
