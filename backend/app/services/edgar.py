from __future__ import annotations

import asyncio
import logging
import re
import warnings

import httpx
from bs4 import BeautifulSoup, XMLParsedAsHTMLWarning

from app.cache import peers_cache, profile_cache
from app.config import settings
from app.models.schemas import CompanyProfile, CompanySearchResult, Filing
from app.services.company_names import clean_company_name


logger = logging.getLogger(__name__)

_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
_ARCHIVES_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/{document}"
# Legacy CGI, not a documented API — see docs/edgar.md for what it lies about.
_PEERS_URL = (
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&SIC={sic}"
    "&type=10-K&owner=include&count=100&output=atom&start={start}"
)
# Server-enforced: count=400 is silently clamped to 100.
_PEERS_PAGE = 100
# The feed is alphabetical by company name and reports no total, so the scan depth is a guess
# that has to be paid for. Six pages covers SIC 3674 entirely (505 filers, measured), and a
# dense SIC's largest filers are unreachable at any smaller budget — NVDA is filer ~430 of its own.
_PEERS_MAX_PAGES = 6
# This host stalls at random: the same page answers in 0.7s or in 18s, independent of the
# query. Timing out short turns a stall into a retry against a fresh, usually fast response,
# which is far cheaper than waiting one out six times over.
_PEERS_TIMEOUT = 8.0
# Ceiling on the whole scan. Six pages each retrying three times is a minute of held request
# on a bad EDGAR day, and no peer list is worth that — the same reasoning that bounds the
# profile lookup in the analysis pipeline.
_PEERS_TOTAL_TIMEOUT = 30.0

_ticker_map: list[CompanySearchResult] = []
# CIK -> company, for intersecting hundreds of feed CIKs at once (search_tickers' linear scan
# is fine for one query, not for 600). Keyed on int: the feed pads CIKs to ten digits and the
# map does not. First entry wins, and since the map is market-cap ordered that picks the common
# share over the warrant for a CIK carrying several tickers (BZAI before BZAIW).
_cik_index: dict[int, CompanySearchResult] = {}

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
    global _ticker_map, _cik_index
    resp = await _get_with_retry(_TICKERS_URL, timeout=30)
    data = resp.json()

    _ticker_map = [
        CompanySearchResult(
            cik=str(entry["cik_str"]),
            ticker=entry["ticker"],
            name=clean_company_name(entry["title"]),
        )
        for entry in data.values()
    ]
    index: dict[int, CompanySearchResult] = {}
    for company in _ticker_map:
        index.setdefault(int(company.cik), company)
    _cik_index = index
    logger.info(
        "Loaded %d tickers from SEC across %d companies", len(_ticker_map), len(_cik_index)
    )


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


def company_by_cik(cik: str) -> CompanySearchResult | None:
    """The listed company at this CIK, or None for a private or delisted filer."""
    return _cik_index.get(int(cik))


def _parse_items(raw: object) -> list[str]:
    """The 8-K item codes for one filing, out of the feed's comma-separated string.

    EDGAR populates this on 8-K forms only — verified 2026-09-06 across five filers, where
    every 8-K row carried at least one code and no other form did except `EFFECT`. Sorted
    rather than left in feed order: 9.01 (Exhibits) rides along on 83% of 8-Ks and says
    nothing about what happened, and ascending order is what keeps it off the front."""
    if not isinstance(raw, str):
        return []
    return sorted({code.strip() for code in raw.split(",") if code.strip()})


async def get_filings(
    cik: str,
    form_types: list[str] | None = None,
    limit: int = 10,
) -> list[Filing]:
    padded_cik = cik.zfill(10)
    url = _SUBMISSIONS_URL.format(cik=padded_cik)

    resp = await _get_with_retry(url, timeout=30)
    data = resp.json()

    # Free ride: this document is already parsed and the classification is a few strings of
    # it. Keeping them here is what makes the analysis pipeline's profile lookup cost nothing.
    profile_cache.set(padded_cik, _parse_company_profile(padded_cik, data))

    recent = data.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    accessions = recent.get("accessionNumber", [])
    dates = recent.get("filingDate", [])
    primary_docs = recent.get("primaryDocument", [])
    primary_descs = recent.get("primaryDocDescription", [])
    item_codes = recent.get("items", [])

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
                items=_parse_items(item_codes[i] if i < len(item_codes) else ""),
            )
        )
        if len(filings) >= limit:
            break

    return filings


def _clean_profile_field(value: object) -> str | None:
    """EDGAR sends an unclassified filer's fields as empty strings, not null or absent.
    Roughly a quarter of listed filers hit this, so an unnormalized '' would become the
    stored value and make `sic IS NOT NULL` match rows that carry no classification.
    Total over `object`, not `str`: pydantic won't coerce a stray number, and a
    ValidationError here would be swallowed into three silent Nones by the caller."""
    if not isinstance(value, str):
        return None
    return value.strip() or None


def _parse_company_profile(padded_cik: str, data: dict) -> CompanyProfile:
    """Pure, so the two callers below cannot drift apart on what a profile is."""
    return CompanyProfile(
        cik=padded_cik,
        sic=_clean_profile_field(data.get("sic")),
        sic_description=_clean_profile_field(data.get("sicDescription")),
        owner_org=_clean_profile_field(data.get("ownerOrg")),
    )


async def get_company_profile(cik: str) -> CompanyProfile:
    """The filer's SEC classification, out of the same submissions document as get_filings().

    Cached in the service rather than in a router (unlike filings/financials) because
    `get_filings` can fill it for free: the user lists a company's filings seconds before
    analyzing one, and that request already parsed this document. A router-level cache
    would leave every analysis re-downloading it — 4.4 MB for a filer like JPM."""
    padded_cik = cik.zfill(10)
    cached = profile_cache.get(padded_cik)
    if cached is not None:
        return cached

    resp = await _get_with_retry(_SUBMISSIONS_URL.format(cik=padded_cik), timeout=30)
    profile = _parse_company_profile(padded_cik, resp.json())
    profile_cache.set(padded_cik, profile)
    return profile


def _parse_peer_ciks(xml: str) -> list[str]:
    """CIKs from one page of the SIC atom feed, in feed order.

    `<cik>` is the only trustworthy element here: a long-standing EDGAR bug renders both
    `entry@title` and `company-info@name` as `ARRAY(0x55e2517f1908)`, so peer names MUST come
    from `_cik_index`. Parsed as HTML because that is the parser already in requirements and it
    reads this feed correctly; the warning it raises about doing so is the point, not a problem."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", XMLParsedAsHTMLWarning)
        soup = BeautifulSoup(xml, "html.parser")
    return [tag.get_text(strip=True) for tag in soup.find_all("cik")]


async def _fetch_peer_page(sic: str, start: int) -> list[str]:
    resp = await _get_with_retry(
        _PEERS_URL.format(sic=sic, start=start), timeout=_PEERS_TIMEOUT
    )
    return _parse_peer_ciks(resp.text)


async def _scan_sic(padded: str) -> tuple[list[str], bool]:
    """Every filer CIK under `padded`, and whether the scan reached the end of the code."""
    ciks = await _fetch_peer_page(padded, 0)
    # A short first page is the whole SIC, so the sparse codes cost exactly one request.
    if len(ciks) < _PEERS_PAGE:
        return ciks, True

    complete = True
    pages = await asyncio.gather(
        *(
            _fetch_peer_page(padded, start * _PEERS_PAGE)
            for start in range(1, _PEERS_MAX_PAGES)
        ),
        return_exceptions=True,
    )
    for page in pages:
        if isinstance(page, BaseException):
            logger.warning("Peer feed page failed for SIC %s", padded, exc_info=page)
            complete = False
            continue
        ciks += page
    return ciks, complete


async def get_peers(sic: str) -> list[CompanySearchResult]:
    """Listed companies filed under `sic`, most prominent first, uncapped.

    Degrades to an empty list on any feed failure — a peer list is a suggestion, and it must
    never be able to take down the page that renders it."""
    padded = sic.zfill(4)
    cached = peers_cache.get(padded)
    if cached is not None:
        return cached

    try:
        ciks, complete = await asyncio.wait_for(
            _scan_sic(padded), timeout=_PEERS_TOTAL_TIMEOUT
        )
    except Exception:
        logger.warning("Peer feed failed for SIC %s", padded, exc_info=True)
        return []

    # _cik_index is insertion-ordered by market cap, so walking it ranks and dedupes at once.
    wanted = {int(cik) for cik in ciks}
    peers = [company for key, company in _cik_index.items() if key in wanted]

    # A partial scan is still a good answer, but caching one would freeze a transient EDGAR
    # failure in place for a full day.
    if complete:
        peers_cache.set(padded, peers)
    return peers


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


# Every form the app analyzes, so a stored analysis is always one of these.
ANALYZED_FORM_TYPES = ["10-K", "10-Q", "10-K/A", "10-Q/A"]
# EDGAR's "recent" block holds ~1000 filings — far more 10-K/10-Qs than any company
# files, so a stored analysis is effectively always in it.
SUBMISSIONS_LIMIT = 1000


def find_primary_document(accession_number: str, filings: list[Filing]) -> str | None:
    """Match a stored (dashless) accession against EDGAR's dashed ones.
    Pure, so a caller holding a cached submissions list can reuse it without refetching."""
    for filing in filings:
        if filing.accession_number.replace("-", "") == accession_number:
            return filing.primary_document
    return None


async def resolve_primary_document(cik: str, accession_number: str) -> str | None:
    """The filing's primary document, fetched from EDGAR's submissions feed.
    A stored analysis keeps the accession but not the document path, and re-fetching the
    filing text needs both. None when the filing has aged out of the recent block."""
    filings = await get_filings(
        cik, form_types=ANALYZED_FORM_TYPES, limit=SUBMISSIONS_LIMIT
    )
    return find_primary_document(accession_number, filings)


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
