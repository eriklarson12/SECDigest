import httpx
import pytest
import respx

from app.config import settings
from app.services import edgar


TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK0000320193.json"
ARCHIVES_URL = (
    "https://www.sec.gov/Archives/edgar/data/320193/000032019325000057/aapl-q2.htm"
)


@respx.mock
async def _load(tickers_json):
    respx.get(TICKERS_URL).mock(return_value=httpx.Response(200, json=tickers_json))
    await edgar.load_tickers()


# --- search_tickers ---

async def test_search_ranking_exact_beats_prefix_beats_contains(tickers_json):
    await _load(tickers_json)
    results = edgar.search_tickers("A")
    assert [c.ticker for c in results] == ["A", "AAPL", "GOOGL"]


async def test_search_case_insensitive(tickers_json):
    await _load(tickers_json)
    assert edgar.search_tickers("aapl")[0].ticker == "AAPL"


async def test_search_empty_query_returns_nothing(tickers_json):
    await _load(tickers_json)
    assert edgar.search_tickers("   ") == []


async def test_search_limit_respected(tickers_json):
    await _load(tickers_json)
    assert len(edgar.search_tickers("A", limit=2)) == 2


async def test_ticker_map_loaded_flag(tickers_json):
    assert not edgar.ticker_map_loaded()
    await _load(tickers_json)
    assert edgar.ticker_map_loaded()


# --- get_filings ---

@respx.mock
async def test_get_filings_pads_cik_and_filters_forms(submissions_json):
    route = respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    filings = await edgar.get_filings("320193")
    assert route.called  # URL contained the 10-digit zero-padded CIK
    assert [f.form_type for f in filings] == ["10-Q", "10-K"]  # 8-K excluded


@respx.mock
async def test_get_filings_limit(submissions_json):
    respx.get(SUBMISSIONS_URL).mock(return_value=httpx.Response(200, json=submissions_json))
    filings = await edgar.get_filings("320193", limit=1)
    assert len(filings) == 1


@respx.mock
async def test_get_filings_short_description_array(submissions_json):
    respx.get(SUBMISSIONS_URL).mock(return_value=httpx.Response(200, json=submissions_json))
    filings = await edgar.get_filings("320193")
    # 10-K is index 2 but descriptions only has 2 entries — must not crash
    assert filings[1].primary_doc_description is None


# --- fetch_filing_text ---

@respx.mock
async def test_fetch_filing_text_strips_scripts_and_styles(filing_html):
    respx.get(ARCHIVES_URL).mock(return_value=httpx.Response(200, text=filing_html))
    text = await edgar.fetch_filing_text("320193", "0000320193-25-000057", "aapl-q2.htm")
    assert "Total revenue was $1,000 million" in text
    assert "alert" not in text
    assert "color: red" not in text


@respx.mock
async def test_fetch_filing_text_truncates(monkeypatch, filing_html):
    monkeypatch.setattr(settings, "max_filing_chars", 20)
    respx.get(ARCHIVES_URL).mock(return_value=httpx.Response(200, text=filing_html))
    text = await edgar.fetch_filing_text("320193", "000032019325000057", "aapl-q2.htm")
    assert len(text) == 20


@respx.mock
async def test_fetch_filing_text_sends_user_agent(filing_html):
    route = respx.get(ARCHIVES_URL).mock(return_value=httpx.Response(200, text=filing_html))
    await edgar.fetch_filing_text("320193", "0000320193-25-000057", "aapl-q2.htm")
    assert route.calls[0].request.headers["User-Agent"] == settings.sec_user_agent


# --- section targeting (_prioritize_sections) ---

def _fake_10k(filler: str = "z") -> str:
    """A synthetic long 10-K: TOC mentions first, real sections later."""
    toc = (
        "TABLE OF CONTENTS\n"
        "Item 1A. Risk Factors ..... 12\n"
        "Item 7. Management's Discussion and Analysis ..... 45\n"
    )
    body = filler * 30_000
    risk = "Item 1A. Risk Factors\nREAL_RISK_SECTION about supply chains.\n"
    between = filler * 5_000
    risk_end = "Item 1B. Unresolved Staff Comments\n"
    mda = "Item 7. Management's Discussion and Analysis\nREAL_MDA_SECTION on margins.\n"
    mda_end = "Item 8. Financial Statements\n"
    tail = filler * 30_000
    return toc + body + risk + between + risk_end + mda + mda_end + tail


def test_prioritize_keeps_head_risk_and_mda_within_cap():
    text = _fake_10k()
    cap = 40_000  # smaller than the ~65K document
    out = edgar._prioritize_sections(text, cap)
    assert len(out) <= cap
    assert "TABLE OF CONTENTS" in out          # head kept
    assert "REAL_RISK_SECTION" in out           # last (real) match, not the TOC line
    assert "REAL_MDA_SECTION" in out


@pytest.mark.parametrize(
    "heading",
    [
        "Item 7. Management's Discussion and Analysis",   # straight apostrophe
        "Item 7. Management’s Discussion and Analysis",   # curly (U+2019) — the common one
        "Item 2—Management’s Discussion and Analysis",    # em dash, no spaces (COST)
        "Item 2-Management’s Discussion and Analysis",    # hyphen (AMD)
        "Item 2,\nManagement's Discussion and Analysis",  # comma + newline (TSLA)
        "ITEM 2. MANAGEMENT’S DISCUSSION AND ANALYSIS",   # shouting (MSFT, GOOGL)
        "Item 2.    Management’s Discussion and Analysis",  # runs of spaces (AAPL)
    ],
)
def test_mda_heading_variants_are_all_found(heading):
    """Filers punctuate this heading every way there is.
    The curly apostrophe is not an edge case — matching only straight missed MD&A in 5 of 6 sampled filings."""
    assert edgar._MDA_START_RE.search(heading) is not None


def test_mda_cross_reference_does_not_shadow_the_real_heading():
    """`Item 7, "Management's Discussion..."` is a pointer, not the section.
    _find_section takes the *last* match to skip the table of contents, so an unmatched cross-reference would otherwise win."""
    text = (
        "Item 7. Management’s Discussion and Analysis\nREAL_MDA_SECTION\n"
        + "z" * 5_000
        + "Item 8. Financial Statements\n"
        + "See Item 7, “Management’s Discussion and Analysis” for details.\n"
    )
    span = edgar._find_section(text, edgar._MDA_START_RE, edgar._MDA_END_RE)
    assert span is not None
    assert "REAL_MDA_SECTION" in text[span[0] : span[1]]


def test_risk_heading_variants_are_all_found():
    for heading in ("Item 1A. Risk Factors", "ITEM 1A—RISK FACTORS", "Item 1A: Risk Factors"):
        assert edgar._RISK_START_RE.search(heading) is not None, heading


def test_prioritize_no_markers_falls_back_to_plain_truncation():
    text = "q" * 50_000
    assert edgar._prioritize_sections(text, 10_000) == "q" * 10_000


def test_prioritize_short_text_untouched():
    text = "Item 1A. Risk Factors\nshort filing"
    assert edgar._prioritize_sections(text, 10_000) == text


# --- retry behavior ---

@respx.mock
async def test_retry_succeeds_after_throttling(filing_html):
    route = respx.get(ARCHIVES_URL).mock(
        side_effect=[
            httpx.Response(429),
            httpx.Response(429),
            httpx.Response(200, text=filing_html),
        ]
    )
    text = await edgar.fetch_filing_text("320193", "0000320193-25-000057", "aapl-q2.htm")
    assert route.call_count == 3
    assert "Total revenue" in text


@respx.mock
async def test_retry_gives_up_after_three_attempts():
    route = respx.get(ARCHIVES_URL).mock(return_value=httpx.Response(500))
    with pytest.raises(httpx.HTTPStatusError):
        await edgar.fetch_filing_text("320193", "0000320193-25-000057", "aapl-q2.htm")
    assert route.call_count == 3


@respx.mock
async def test_404_is_not_retried():
    route = respx.get(SUBMISSIONS_URL).mock(return_value=httpx.Response(404))
    with pytest.raises(httpx.HTTPStatusError):
        await edgar.get_filings("320193")
    assert route.call_count == 1


@respx.mock
async def test_transport_error_retried_then_raises():
    route = respx.get(SUBMISSIONS_URL).mock(side_effect=httpx.ConnectError("boom"))
    with pytest.raises(httpx.TransportError):
        await edgar.get_filings("320193")
    assert route.call_count == 3


# --- Company profile (roadmap 8.1) ---


@respx.mock
async def test_get_company_profile_reads_classification(submissions_json):
    route = respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    profile = await edgar.get_company_profile("320193")
    assert route.called  # URL contained the 10-digit zero-padded CIK
    assert profile.sic == "3571"
    assert profile.sic_description == "Electronic Computers"
    assert profile.owner_org == "06 Technology"


@respx.mock
async def test_empty_classification_normalizes_to_none(unclassified_submissions_json):
    """EDGAR sends '' rather than null; stored as-is it would make `sic IS NOT NULL` lie."""
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=unclassified_submissions_json)
    )
    profile = await edgar.get_company_profile("320193")
    assert profile.sic is None
    assert profile.sic_description is None
    assert profile.owner_org is None


@respx.mock
async def test_missing_classification_keys_are_none():
    """A submissions document with no classification keys at all must not raise."""
    respx.get(SUBMISSIONS_URL).mock(return_value=httpx.Response(200, json={"filings": {}}))
    profile = await edgar.get_company_profile("320193")
    assert (profile.sic, profile.sic_description, profile.owner_org) == (None, None, None)


@respx.mock
async def test_zero_padded_sic_stays_a_string():
    """'0700' is Agricultural Services; 700 is a different code, and int() would eat the pad."""
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json={"sic": "0700", "sicDescription": "Agricultural Services"})
    )
    profile = await edgar.get_company_profile("320193")
    assert profile.sic == "0700"


@respx.mock
async def test_get_filings_warms_the_profile_cache(submissions_json):
    """The whole cost argument for 8.1: listing a company's filings parses this document
    already, so the analysis that follows pays nothing for the classification."""
    route = respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    await edgar.get_filings("320193")
    profile = await edgar.get_company_profile("320193")
    assert route.call_count == 1
    assert profile.sic == "3571"


@respx.mock
async def test_profile_echoes_the_padded_cik(submissions_json):
    """The cached object is shared, so its cik must not vary with the caller's padding."""
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    profile = await edgar.get_company_profile("320193")
    assert profile.cik == "0000320193"


@respx.mock
async def test_profile_is_cached_per_company(submissions_json):
    route = respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    await edgar.get_company_profile("320193")
    await edgar.get_company_profile("320193")
    assert route.call_count == 1


@respx.mock
async def test_profile_cache_keys_on_padded_cik(submissions_json):
    """The filings router caches under the raw client CIK, so 320193 and 0000320193 are
    separate entries there. The profile cache must not repeat that."""
    route = respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions_json)
    )
    await edgar.get_company_profile("320193")
    await edgar.get_company_profile("0000320193")
    assert route.call_count == 1
