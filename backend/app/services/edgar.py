from __future__ import annotations

import asyncio
import logging
import re

import httpx
from bs4 import BeautifulSoup

from app.config import settings
from app.models.schemas import CompanySearchResult, Filing


logger = logging.getLogger(__name__)

_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
_ARCHIVES_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/{document}"

_ticker_map: list[CompanySearchResult] = []

# SEC fair-access policy: stay well under 10 req/s (docs/edgar.md)
_semaphore = asyncio.Semaphore(4)
_RETRY_ATTEMPTS = 3
_RETRY_BASE_DELAY = 1.0
_RETRYABLE_STATUSES = {403, 429, 500, 502, 503, 504}

# Shared client, opened/closed by the app lifespan; created lazily otherwise
_client: httpx.AsyncClient | None = None


def _headers() -> dict[str, str]:
    return {
        "User-Agent": settings.sec_user_agent,
        "Accept-Encoding": "gzip, deflate",
    }


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(follow_redirects=True)
    return _client


async def close_client() -> None:
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


async def _get_with_retry(url: str, timeout: float) -> httpx.Response:
    """GET with the EDGAR throttle and retry on throttling/server/transport errors."""
    delay = _RETRY_BASE_DELAY
    for attempt in range(_RETRY_ATTEMPTS):
        last_attempt = attempt == _RETRY_ATTEMPTS - 1
        try:
            async with _semaphore:
                resp = await _get_client().get(url, headers=_headers(), timeout=timeout)
        except httpx.TransportError:
            if last_attempt:
                raise
            await asyncio.sleep(delay)
            delay *= 2
            continue

        if resp.status_code in _RETRYABLE_STATUSES and not last_attempt:
            await asyncio.sleep(delay)
            delay *= 2
            continue

        resp.raise_for_status()
        return resp

    raise httpx.TransportError("EDGAR request failed after retries")  # unreachable


def ticker_map_loaded() -> bool:
    return bool(_ticker_map)


async def load_tickers() -> None:
    global _ticker_map
    resp = await _get_with_retry(_TICKERS_URL, timeout=30)
    data = resp.json()

    _ticker_map = [
        CompanySearchResult(
            cik=str(entry["cik_str"]),
            ticker=entry["ticker"],
            name=entry["title"],
        )
        for entry in data.values()
    ]
    logger.info("Loaded %d tickers from SEC", len(_ticker_map))


def search_tickers(query: str, limit: int = 10) -> list[CompanySearchResult]:
    q = query.upper().strip()
    if not q:
        return []

    exact = []
    prefix = []
    contains = []

    for company in _ticker_map:
        ticker_upper = company.ticker.upper()
        name_upper = company.name.upper()

        if ticker_upper == q:
            exact.append(company)
        elif ticker_upper.startswith(q):
            prefix.append(company)
        elif q in ticker_upper or q in name_upper:
            contains.append(company)

    results = exact + prefix + contains
    return results[:limit]


async def get_filings(
    cik: str,
    form_types: list[str] | None = None,
    limit: int = 10,
) -> list[Filing]:
    padded_cik = cik.zfill(10)
    url = _SUBMISSIONS_URL.format(cik=padded_cik)

    resp = await _get_with_retry(url, timeout=30)
    data = resp.json()

    recent = data.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    accessions = recent.get("accessionNumber", [])
    dates = recent.get("filingDate", [])
    primary_docs = recent.get("primaryDocument", [])
    primary_descs = recent.get("primaryDocDescription", [])

    if form_types:
        allowed = {ft.upper() for ft in form_types}
    else:
        allowed = {"10-K", "10-Q"}

    filings: list[Filing] = []
    for i in range(len(forms)):
        if forms[i].upper() not in allowed:
            continue
        filings.append(
            Filing(
                accession_number=accessions[i],
                form_type=forms[i],
                filing_date=dates[i],
                primary_document=primary_docs[i],
                primary_doc_description=primary_descs[i] if i < len(primary_descs) else None,
            )
        )
        if len(filings) >= limit:
            break

    return filings


# --- Section targeting (docs/edgar.md) ---
# Blind truncation can cut Risk Factors/MD&A from giant 10-Ks; prioritize those plus the head (cover page + summaries carry the headline figures).

_HEAD_CHARS = 20_000
# Filers punctuate headings every way there is — "Item 1A." / "Item 7 —" /
# "ITEM 2:" — so the separator is a character class rather than a literal.
_SEP = r"[\s.,:;—–-]*"
# Straight and curly apostrophes — real filings mostly use curly (U+2019); matching only straight
# missed the MD&A heading in 5 of 6 filings sampled, silently degrading _prioritize_sections to head+risk.
_APOS = r"['’‘`]?"
_RISK_START_RE = re.compile(rf"item{_SEP}1a{_SEP}risk\s+factors", re.I)
_RISK_END_RE = re.compile(r"item\s*1b\b|item\s*2\b", re.I)
# Item 7 in 10-Ks, Item 2 in 10-Qs. Deliberately excludes a leading quote: `Item 7, "Management's
# Discussion..."` is a cross-reference, and matching it would point last-match at the notes, not the heading.
_MDA_START_RE = re.compile(
    rf"item{_SEP}[27]{_SEP}management{_APOS}s?\s+discussion", re.I
)
_MDA_END_RE = re.compile(r"item\s*[38]\b", re.I)


def _find_section(
    text: str, start_re: re.Pattern[str], end_re: re.Pattern[str]
) -> tuple[int, int] | None:
    starts = list(start_re.finditer(text))
    if not starts:
        return None
    # The first occurrence is usually the table of contents — take the last.
    start = starts[-1]
    end_match = end_re.search(text, start.end())
    end = end_match.start() if end_match else len(text)
    return (start.start(), end)


def _prioritize_sections(text: str, max_chars: int) -> str:
    """Fit Risk Factors + MD&A + document head within max_chars.
    Falls back silently to plain truncation when no section markers are found (exhibit-style filings)."""
    if len(text) <= max_chars:
        return text

    risk = _find_section(text, _RISK_START_RE, _RISK_END_RE)
    mda = _find_section(text, _MDA_START_RE, _MDA_END_RE)
    if risk is None and mda is None:
        logger.debug("No Item markers found; plain truncation")
        return text[:max_chars]

    ranges = [(0, _HEAD_CHARS)]
    ranges += [r for r in (mda, risk) if r is not None]
    ranges.sort()
    merged: list[tuple[int, int]] = []
    for s, e in ranges:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))

    # Priority sections first, then spend any leftover budget on the gaps
    # between them, in document order.
    included: list[tuple[int, int]] = []
    budget = max_chars
    for s, e in merged:
        if budget <= 0:
            break
        e = min(e, s + budget)
        included.append((s, e))
        budget -= e - s
    if budget > 0:
        gaps: list[tuple[int, int]] = []
        prev = 0
        for s, e in included:
            if s > prev:
                gaps.append((prev, s))
            prev = e
        if prev < len(text):
            gaps.append((prev, len(text)))
        for s, e in gaps:
            if budget <= 0:
                break
            e = min(e, s + budget)
            included.append((s, e))
            budget -= e - s

    return "\n\n".join(text[s:e] for s, e in sorted(included))[:max_chars]


async def fetch_filing_text(cik: str, accession_number: str, primary_document: str) -> str:
    """Download filing HTML from EDGAR and convert to truncated plain text."""
    accession_no_dashes = accession_number.replace("-", "")
    url = _ARCHIVES_URL.format(
        cik=cik,
        accession=accession_no_dashes,
        document=primary_document,
    )

    resp = await _get_with_retry(url, timeout=60)
    html = resp.text

    soup = BeautifulSoup(html, "html.parser")

    for tag in soup(["script", "style"]):
        tag.decompose()

    text = soup.get_text(separator="\n")

    lines = [line.strip() for line in text.splitlines()]
    text = "\n".join(line for line in lines if line)

    # Bound LLM input (free-tier token/minute caps — docs/decisions.md),
    # keeping Risk Factors + MD&A when the filing exceeds the cap
    return _prioritize_sections(text, settings.max_filing_chars)
