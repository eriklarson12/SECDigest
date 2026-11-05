"""Earnings releases (roadmap 15.3): find the 8-K's press release and check the LLM's figures.

Pure, no I/O. Measured 2026-11-04 on AAPL, NVDA, JPM, MSFT and WRLD: the release is always
EX-99.1, and only the filing's `-index-headers.html` names its file."""

import html
import re

from app.models.schemas import EarningsFigure

MAX_FIGURES = 8

_RELEASE_TYPE = "EX-99.1"
_DOCUMENT_RE = re.compile(r"<TYPE>([^\s<]+).*?<FILENAME>([^\s<]+)", re.S)
# The file name reaches an Archives URL, so it is allowlisted: no path separators, no `..`.
_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.html?$")
_NUMBER_RE = re.compile(r"\d[\d,]*(?:\.\d+)?")
_SPACE_RE = re.compile(r"\s+")


def release_document(headers_html: str) -> str | None:
    """The EX-99.1 file name from a filing's index headers, or None when there is none.
    The headers page escapes the SGML tags, so it is unescaped before matching."""
    for doc_type, name in _DOCUMENT_RE.findall(html.unescape(headers_html)):
        if doc_type == _RELEASE_TYPE:
            return name if _SAFE_NAME_RE.match(name) else None
    return None


def _collapse(text: str) -> str:
    # `\s` covers the `\xa0` that `&nbsp;` becomes; the model writes a plain space back.
    return _SPACE_RE.sub(" ", text).strip()


def _supported(figure: EarningsFigure, text: str) -> bool:
    quote = _collapse(figure.quote)
    if not quote or quote not in text:
        return False
    number = _NUMBER_RE.search(figure.value)
    return number is None or number.group().replace(",", "") in quote.replace(",", "")


def keep_supported(figures: list[EarningsFigure], text: str) -> list[EarningsFigure]:
    """The figures whose quote occurs in the release and contains the figure's number."""
    collapsed = _collapse(text)
    return [f for f in figures if _supported(f, collapsed)][:MAX_FIGURES]
