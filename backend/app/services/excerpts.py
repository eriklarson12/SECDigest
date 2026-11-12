"""The display trim of a retrieved chunk, echoed back as an ask source (roadmap 16.9).

A chunk is a fixed character window (`embeddings.chunk_text`), so it usually opens mid-word:
"reased during 2026". The model always sees the whole chunk; only the excerpt shown to the
reader is trimmed, and the Q&A eval scores against full chunks, never this."""

import re

EXCERPT_CHARS = 300
ELLIPSIS = "…"

# A token kept at the cut. Text before a chunk's first space is otherwise a fragment.
_WORD_START = re.compile(r"[A-Z$(\[{“‘\"'#]")
_FIRST_TOKEN = re.compile(r"\S*\s+")
_SENTENCE_END = re.compile(r"[.!?][\"')\]”’]*$")
# How far back from the limit the end may retreat to a space before it hard-cuts instead.
_END_SLACK = 40


def display_excerpt(content: str, chunk_index: int, limit: int = EXCERPT_CHARS) -> str:
    """The chunk from its first word boundary, prefixed with "…" unless it opens a sentence.

    Chunk 0 starts the filing and is kept whole. Elsewhere a capital or an opening mark is
    taken as a word start; a lowercase letter or a digit is not, and dropping a number's
    head matters most, since "78.8 billion" cut from "478.8 billion" reads as a real figure.
    The window's start is unknown, so a capital at the cut still takes the "…"."""
    text = content.strip()
    if chunk_index == 0 or not text:
        return _end(text, limit)

    opens_sentence = False
    if not _WORD_START.match(text):
        token = _FIRST_TOKEN.match(text)
        if token:
            text = text[token.end() :]
            opens_sentence = bool(
                _SENTENCE_END.search(token.group().rstrip()) and _WORD_START.match(text)
            )
    body = _end(text, limit)
    return body if opens_sentence else ELLIPSIS + body


def _end(text: str, limit: int) -> str:
    """At most `limit` characters, ending on a word when one ends near the limit."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind(" ")
    return cut[:space].rstrip(" ,;:") if space >= limit - _END_SLACK else cut
