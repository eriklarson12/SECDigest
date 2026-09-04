import asyncio

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


# --- Peer discovery (roadmap 8.3) ---

def _peers_url(start=0, sic="3674"):
    return edgar._PEERS_URL.format(sic=sic, start=start)


@pytest.fixture
def peer_tickers_json():
    """Market-cap order, which is how company_tickers.json really arrives — NVDA first, not
    alphabetically first. ADVANTEST's two tickers are real: one CIK, common plus an ADR."""
    return {
        "0": {"cik_str": 1045810, "ticker": "NVDA", "title": "NVIDIA CORP"},
        "1": {"cik_str": 2488, "ticker": "AMD", "title": "ADVANCED MICRO DEVICES INC"},
        "2": {"cik_str": 50863, "ticker": "INTC", "title": "INTEL CORP"},
        "3": {"cik_str": 1158838, "ticker": "ATEYY", "title": "ADVANTEST CORP"},
        "4": {"cik_str": 1158838, "ticker": "ADTTF", "title": "ADVANTEST CORP"},
        "5": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
    }


async def _load_peer_map(peer_tickers_json):
    await _load(peer_tickers_json)


@respx.mock
async def test_peers_match_padded_feed_ciks_against_the_unpadded_map(
    peer_tickers_json, peers_atom
):
    """The feed pads CIKs to ten digits, the ticker map does not. Comparing the strings
    would drop every peer and return a silently empty list."""
    await _load_peer_map(peer_tickers_json)
    respx.get(_peers_url()).mock(
        return_value=httpx.Response(200, text=peers_atom([2488, 50863]))
    )
    peers = await edgar.get_peers("3674")
    assert [p.ticker for p in peers] == ["AMD", "INTC"]


@respx.mock
async def test_peers_drop_filers_with_no_ticker(peer_tickers_json, peers_atom):
    await _load_peer_map(peer_tickers_json)
    respx.get(_peers_url()).mock(
        return_value=httpx.Response(200, text=peers_atom([2488, 999999999]))
    )
    assert [p.ticker for p in await edgar.get_peers("3674")] == ["AMD"]


@respx.mock
async def test_one_cik_with_two_tickers_yields_one_peer(peer_tickers_json, peers_atom):
    """8,005 distinct CIKs across 10,412 map entries — a CIK can carry a common share and a
    warrant or ADR. The map's first entry wins, which is the larger listing."""
    await _load_peer_map(peer_tickers_json)
    respx.get(_peers_url()).mock(
        return_value=httpx.Response(200, text=peers_atom([1158838]))
    )
    assert [p.ticker for p in await edgar.get_peers("3674")] == ["ATEYY"]


@respx.mock
async def test_peers_are_ranked_by_market_cap_not_feed_order(peer_tickers_json, peers_atom):
    """The feed is alphabetical, so feed order would put AMD ahead of NVDA. company_tickers.json
    is ordered by market cap, and that ordering is what makes the cap of 20 worth having."""
    await _load_peer_map(peer_tickers_json)
    respx.get(_peers_url()).mock(
        return_value=httpx.Response(200, text=peers_atom([2488, 50863, 1045810]))
    )
    assert [p.ticker for p in await edgar.get_peers("3674")] == ["NVDA", "AMD", "INTC"]


@respx.mock
async def test_a_short_first_page_costs_exactly_one_request(peer_tickers_json, peers_atom):
    """A page below the server's 100 is the whole SIC. Sparse codes must not pay for six."""
    await _load_peer_map(peer_tickers_json)
    route = respx.get(_peers_url()).mock(
        return_value=httpx.Response(200, text=peers_atom([2488]))
    )
    await edgar.get_peers("3674")
    assert route.call_count == 1


@respx.mock
async def test_a_full_first_page_fetches_the_rest(peer_tickers_json, peers_atom):
    """SIC 3674 holds 505 filers and NVDA is filer ~430 of them — stopping at page one
    returns the companies whose names start with A, not the company's actual peers."""
    await _load_peer_map(peer_tickers_json)
    filler = list(range(900_000, 900_000 + edgar._PEERS_PAGE - 1))
    respx.get(_peers_url()).mock(
        return_value=httpx.Response(200, text=peers_atom([2488, *filler]))
    )
    later = [
        respx.get(_peers_url(start=start * edgar._PEERS_PAGE)).mock(
            return_value=httpx.Response(200, text=peers_atom([]))
        )
        for start in range(1, edgar._PEERS_MAX_PAGES)
    ]
    later[2].mock(return_value=httpx.Response(200, text=peers_atom([1045810])))

    assert [p.ticker for p in await edgar.get_peers("3674")] == ["NVDA", "AMD"]
    assert all(route.call_count == 1 for route in later)


@respx.mock
async def test_the_page_budget_stops_the_scan(peer_tickers_json, peers_atom):
    # Pinned deliberately: six pages is 600 filers, which covers SIC 3674's measured 505 in
    # full. Lowering it silently truncates dense codes alphabetically.
    assert edgar._PEERS_MAX_PAGES == 6
    await _load_peer_map(peer_tickers_json)
    full = peers_atom(list(range(900_000, 900_000 + edgar._PEERS_PAGE)))
    routes = [
        respx.get(_peers_url(start=start * edgar._PEERS_PAGE)).mock(
            return_value=httpx.Response(200, text=full)
        )
        for start in range(edgar._PEERS_MAX_PAGES)
    ]
    beyond = respx.get(_peers_url(start=edgar._PEERS_MAX_PAGES * edgar._PEERS_PAGE)).mock(
        return_value=httpx.Response(200, text=full)
    )
    await edgar.get_peers("3674")
    assert all(route.call_count == 1 for route in routes)
    assert beyond.call_count == 0


@respx.mock
async def test_peers_are_cached_per_sic(peer_tickers_json, peers_atom):
    await _load_peer_map(peer_tickers_json)
    route = respx.get(_peers_url()).mock(
        return_value=httpx.Response(200, text=peers_atom([2488]))
    )
    await edgar.get_peers("3674")
    await edgar.get_peers("3674")
    assert route.call_count == 1


@respx.mock
async def test_peers_cache_keys_on_the_padded_sic(peer_tickers_json, peers_atom):
    """A hand-typed ?sic=700 and a generated 0700 are the same code (roadmap 8.2)."""
    await _load_peer_map(peer_tickers_json)
    route = respx.get(_peers_url(sic="0700")).mock(
        return_value=httpx.Response(200, text=peers_atom([2488], sic="0700"))
    )
    await edgar.get_peers("700")
    await edgar.get_peers("0700")
    assert route.call_count == 1


@respx.mock
async def test_a_feed_failure_is_an_empty_list_not_an_exception(peer_tickers_json):
    await _load_peer_map(peer_tickers_json)
    respx.get(_peers_url()).mock(return_value=httpx.Response(404))
    assert await edgar.get_peers("3674") == []


@respx.mock
async def test_a_feed_failure_is_not_cached(peer_tickers_json, peers_atom):
    """Caching a transient EDGAR outage would freeze an empty peer list in place for a day."""
    await _load_peer_map(peer_tickers_json)
    route = respx.get(_peers_url()).mock(
        side_effect=[
            httpx.Response(404),
            httpx.Response(200, text=peers_atom([2488])),
        ]
    )
    assert await edgar.get_peers("3674") == []
    assert [p.ticker for p in await edgar.get_peers("3674")] == ["AMD"]
    assert route.call_count == 2


@respx.mock
async def test_a_partial_scan_is_returned_but_not_cached(peer_tickers_json, peers_atom):
    """One failed page out of six still makes a useful list, but it is not the whole SIC."""
    await _load_peer_map(peer_tickers_json)
    filler = list(range(900_000, 900_000 + edgar._PEERS_PAGE - 1))
    first = respx.get(_peers_url()).mock(
        return_value=httpx.Response(200, text=peers_atom([2488, *filler]))
    )
    respx.get(_peers_url(start=edgar._PEERS_PAGE)).mock(return_value=httpx.Response(500))
    for start in range(2, edgar._PEERS_MAX_PAGES):
        respx.get(_peers_url(start=start * edgar._PEERS_PAGE)).mock(
            return_value=httpx.Response(200, text=peers_atom([]))
        )

    assert [p.ticker for p in await edgar.get_peers("3674")] == ["AMD"]
    await edgar.get_peers("3674")
    assert first.call_count == 2


async def test_company_by_cik_matches_a_padded_cik(peer_tickers_json):
    await _load(peer_tickers_json)
    found = edgar.company_by_cik("0000002488")
    assert found is not None and found.ticker == "AMD"
    assert edgar.company_by_cik("999999999") is None


def test_parse_peer_ciks_reads_every_entry(peers_atom):
    assert edgar._parse_peer_ciks(peers_atom([2488, 1045810])) == [
        "0000002488",
        "0001045810",
    ]


def test_parse_peer_ciks_on_an_unknown_sic_feed(peers_atom):
    """EDGAR answers an unknown SIC with an empty feed and a 200, not an error."""
    assert edgar._parse_peer_ciks(peers_atom([])) == []


def test_parse_peer_ciks_survives_junk():
    assert edgar._parse_peer_ciks("<html><body>Your Request Originates from...</body></html>") == []


async def test_a_stalled_scan_is_abandoned_not_waited_out(monkeypatch, peer_tickers_json):
    """browse-edgar answers the same page in 0.7s or in 18s at random. Six pages each retrying
    three times is a minute of held request, so the whole scan is bounded."""
    await _load(peer_tickers_json)

    async def never(padded):
        await asyncio.sleep(30)

    monkeypatch.setattr(edgar, "_scan_sic", never)
    monkeypatch.setattr(edgar, "_PEERS_TOTAL_TIMEOUT", 0.01)
    # The outer bound is the assertion: without the inner one this hangs until the test suite
    # gives up, which is precisely the failure being guarded against.
    assert await asyncio.wait_for(edgar.get_peers("3674"), timeout=5) == []
    # An abandoned scan is a transient failure, so it must not be cached as an answer.
    assert edgar.peers_cache.get("3674") is None
