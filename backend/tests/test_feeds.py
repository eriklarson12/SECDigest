"""Atom feeds of new filings (roadmap 14.1)."""

import re
import xml.etree.ElementTree as ET
from pathlib import Path

import httpx
import respx
from fastapi.testclient import TestClient

from app.main import app
from app.models.schemas import Filing
from app.services.eightk import ITEM_LABELS
from app.services.feeds import FeedEntry, make_feed_id, newest_first, render_atom

client = TestClient(app, raise_server_exceptions=False)

ATOM = "{http://www.w3.org/2005/Atom}"
TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS = "https://data.sec.gov/submissions/CIK{cik}.json"
EIGHTK_TS = Path(__file__).parents[2] / "frontend" / "src" / "lib" / "eightk.ts"
RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

TICKERS = {
    "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
    "1": {"cik_str": 789019, "ticker": "MSFT", "title": "Microsoft Corp"},
    "2": {"cik_str": 1000001, "ticker": "AMP", "title": "Smith & Sons <Holdings>"},
}


def submissions(rows: list[tuple[str, str, str, str]]) -> dict:
    """`rows` are (form, accession, filing date, item codes), newest first."""
    return {
        "filings": {
            "recent": {
                "form": [r[0] for r in rows],
                "accessionNumber": [r[1] for r in rows],
                "filingDate": [r[2] for r in rows],
                "primaryDocument": ["doc.htm"] * len(rows),
                "primaryDocDescription": [""] * len(rows),
                "items": [r[3] for r in rows],
            }
        }
    }


AAPL_ROWS = [
    ("8-K/A", "0000320193-26-000090", "2026-09-06", "5.02"),
    ("4", "0000320193-26-000089", "2026-09-05", ""),
    ("10-Q", "0000320193-26-000080", "2026-08-01", ""),
    ("8-K", "0000320193-26-000070", "2026-07-31", "9.01,2.02"),
]
MSFT_ROWS = [
    ("10-K", "0000789019-26-000050", "2026-08-15", ""),
    ("8-K", "0000789019-26-000040", "2026-07-30", "7.01"),
]


def mock_edgar(status: dict[str, int] | None = None) -> dict[str, respx.Route]:
    status = status or {}
    respx.get(TICKERS_URL).mock(return_value=httpx.Response(200, json=TICKERS))
    routes = {}
    for cik, rows in (("320193", AAPL_ROWS), ("789019", MSFT_ROWS)):
        routes[cik] = respx.get(SUBMISSIONS.format(cik=cik.zfill(10))).mock(
            return_value=httpx.Response(status.get(cik, 200), json=submissions(rows))
        )
    return routes


def parse(resp: httpx.Response) -> ET.Element:
    return ET.fromstring(resp.content)


def titles(feed: ET.Element) -> list[str]:
    return [e.findtext(f"{ATOM}title") or "" for e in feed.iter(f"{ATOM}entry")]


# --- rendering ---


def entry(form: str, accession: str, day: str, items=(), name="Apple Inc.") -> FeedEntry:
    filing = Filing(
        accession_number=accession,
        form_type=form,
        filing_date=day,
        primary_document="doc.htm",
        items=list(items),
    )
    return FeedEntry(ticker="AAPL", cik="320193", company_name=name, filing=filing)


def render(entries: list[FeedEntry], title="T") -> ET.Element:
    xml = render_atom(
        feed_id=make_feed_id(["AAPL"]),
        title=title,
        self_url="https://api.example/api/feeds/AAPL.atom?a=1&b=2",
        alternate_url="https://site.example/company/AAPL",
        site_url="https://site.example",
        entries=newest_first(entries),
    )
    return ET.fromstring(xml.encode())


def test_markup_in_names_is_escaped():
    feed = render(
        [entry("10-K", "0000000001-26-000001", "2026-01-02", name="Smith & Sons <Holdings>")],
        title="Smith & Sons <Holdings> (AMP) filings",
    )
    assert feed.findtext(f"{ATOM}title") == "Smith & Sons <Holdings> (AMP) filings"
    first = feed.find(f"{ATOM}entry")
    assert first is not None
    assert first.findtext(f"{ATOM}author/{ATOM}name") == "Smith & Sons <Holdings>"
    self_link = feed.find(f"{ATOM}link[@rel='self']")
    assert self_link is not None
    assert self_link.get("href") == "https://api.example/api/feeds/AAPL.atom?a=1&b=2"


def test_required_elements_and_dates():
    feed = render([entry("10-Q", "0000320193-26-000080", "2026-08-01")])
    for tag in ("id", "title", "updated", "author"):
        assert feed.find(f"{ATOM}{tag}") is not None
    assert RFC3339.match(feed.findtext(f"{ATOM}updated") or "")

    first = feed.find(f"{ATOM}entry")
    assert first is not None
    assert first.findtext(f"{ATOM}id") == "tag:secdigest.tech,2026:filing:000032019326000080"
    assert first.findtext(f"{ATOM}updated") == "2026-08-01T00:00:00Z"
    links = {link.get("rel"): link.get("href") for link in first.iter(f"{ATOM}link")}
    assert links == {
        "alternate": "https://www.sec.gov/Archives/edgar/data/320193/000032019326000080/",
        "related": "https://site.example/company/AAPL",
    }


def test_an_empty_feed_still_has_an_updated_date():
    feed = render([])
    assert RFC3339.match(feed.findtext(f"{ATOM}updated") or "")
    assert feed.find(f"{ATOM}entry") is None


def test_newest_first_breaks_date_ties_on_accession():
    feed = render(
        [
            entry("8-K", "0000320193-26-000010", "2026-08-01"),
            entry("10-Q", "0000320193-26-000011", "2026-08-01"),
            entry("10-K", "0000320193-26-000001", "2026-09-01"),
        ]
    )
    assert titles(feed) == ["AAPL 10-K", "AAPL 10-Q", "AAPL 8-K"]


def test_8k_titles_carry_item_labels():
    feed = render([entry("8-K", "0000320193-26-000070", "2026-07-31", ["2.02", "9.01", "6.01"])])
    assert titles(feed) == ["AAPL 8-K: Results of Operations, Exhibits, Item 6.01"]


def test_feed_id_ignores_ticker_order():
    assert make_feed_id(["MSFT", "AAPL"]) == make_feed_id(["AAPL", "MSFT"])


def test_item_labels_match_the_frontend_map():
    """services/eightk.py is a copy; frontend/src/lib/eightk.ts is the source."""
    source = EIGHTK_TS.read_text()
    block = source.split("export const ITEM_LABELS")[1].split("};")[0]
    frontend = dict(re.findall(r'"(\d\.\d\d)":\s*"([^"]+)"', block))
    assert frontend == ITEM_LABELS


# --- company feed ---


@respx.mock
def test_company_feed():
    mock_edgar()
    resp = client.get("/api/feeds/AAPL.atom")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/atom+xml; charset=utf-8"
    assert resp.headers["cache-control"] == "public, max-age=900"
    assert "x-ratelimit-limit" in resp.headers

    feed = parse(resp)
    assert feed.findtext(f"{ATOM}title") == "Apple Inc. (AAPL) filings"
    # The Form 4 is not a feed form; the amendment is.
    assert titles(feed) == [
        "AAPL 8-K/A: Departure or Election of Directors or Officers",
        "AAPL 10-Q",
        "AAPL 8-K: Results of Operations, Exhibits",
    ]


@respx.mock
def test_company_feed_is_case_insensitive():
    mock_edgar()
    assert client.get("/api/feeds/aapl.atom").status_code == 200


@respx.mock
def test_unknown_ticker_is_404():
    mock_edgar()
    assert client.get("/api/feeds/ZZZZ.atom").status_code == 404


@respx.mock
def test_a_ticker_prefix_is_not_a_match():
    """search_tickers would answer AAP with AAPL; the feed must not."""
    mock_edgar()
    assert client.get("/api/feeds/AAP.atom").status_code == 404


def test_malformed_ticker_is_422():
    assert client.get("/api/feeds/A$B.atom").status_code == 422


@respx.mock
def test_edgar_failure_is_502_and_uncached():
    mock_edgar({"320193": 500})
    resp = client.get("/api/feeds/AAPL.atom")
    assert resp.status_code == 502
    assert "cache-control" not in resp.headers


@respx.mock
def test_unavailable_ticker_map_is_502():
    respx.get(TICKERS_URL).mock(return_value=httpx.Response(500))
    assert client.get("/api/feeds/AAPL.atom").status_code == 502


@respx.mock
def test_a_warm_feed_costs_no_edgar_request():
    routes = mock_edgar()
    client.get("/api/feeds/AAPL.atom")
    client.get("/api/feeds/AAPL.atom")
    client.get("/api/feeds/watchlist.atom?tickers=AAPL")
    assert routes["320193"].call_count == 1


# --- watchlist feed ---


@respx.mock
def test_watchlist_feed_merges_and_sorts():
    mock_edgar()
    resp = client.get("/api/feeds/watchlist.atom?tickers=MSFT,AAPL")
    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "public, max-age=900"
    assert titles(parse(resp)) == [
        "AAPL 8-K/A: Departure or Election of Directors or Officers",
        "MSFT 10-K",
        "AAPL 10-Q",
        "AAPL 8-K: Results of Operations, Exhibits",
        "MSFT 8-K: Regulation FD Disclosure",
    ]


@respx.mock
def test_watchlist_route_is_not_captured_by_the_ticker_route():
    mock_edgar()
    feed = parse(client.get("/api/feeds/watchlist.atom?tickers=AAPL"))
    assert feed.findtext(f"{ATOM}title") == "SECDigest watchlist: AAPL"


@respx.mock
def test_watchlist_drops_unknown_malformed_and_repeated_tickers():
    routes = mock_edgar()
    resp = client.get("/api/feeds/watchlist.atom?tickers=aapl,ZZZZ,A$B,,AAPL")
    assert resp.status_code == 200
    assert parse(resp).findtext(f"{ATOM}title") == "SECDigest watchlist: AAPL"
    assert routes["320193"].call_count == 1


@respx.mock
def test_watchlist_of_only_unknown_tickers_is_an_empty_feed():
    mock_edgar()
    resp = client.get("/api/feeds/watchlist.atom?tickers=ZZZZ")
    assert resp.status_code == 200
    assert parse(resp).find(f"{ATOM}entry") is None


@respx.mock
def test_watchlist_caps_at_twenty_tickers():
    many = {str(i): {"cik_str": 100 + i, "ticker": f"T{i}", "title": f"Co {i}"} for i in range(25)}
    respx.get(TICKERS_URL).mock(return_value=httpx.Response(200, json=many))
    feeds = respx.get(url__regex=r"https://data\.sec\.gov/submissions/.*").mock(
        return_value=httpx.Response(200, json=submissions([]))
    )
    tickers = ",".join(f"T{i}" for i in range(25))
    assert client.get(f"/api/feeds/watchlist.atom?tickers={tickers}").status_code == 200
    assert feeds.call_count == 20


@respx.mock
def test_watchlist_drops_a_ticker_edgar_fails_on():
    mock_edgar({"789019": 500})
    resp = client.get("/api/feeds/watchlist.atom?tickers=AAPL,MSFT")
    assert resp.status_code == 200
    assert all(t.startswith("AAPL") for t in titles(parse(resp)))


@respx.mock
def test_watchlist_is_502_when_every_ticker_fails():
    mock_edgar({"320193": 500, "789019": 500})
    assert client.get("/api/feeds/watchlist.atom?tickers=AAPL,MSFT").status_code == 502


def test_watchlist_without_tickers_is_422():
    assert client.get("/api/feeds/watchlist.atom").status_code == 422
    assert client.get("/api/feeds/watchlist.atom?tickers=,%20,").status_code == 422


@respx.mock
def test_watchlist_feed_has_the_tighter_limit():
    mock_edgar()
    for _ in range(10):
        assert client.get("/api/feeds/watchlist.atom?tickers=AAPL").status_code == 200
    assert client.get("/api/feeds/watchlist.atom?tickers=AAPL").status_code == 429
    # The ticker feed keeps its own budget.
    assert client.get("/api/feeds/AAPL.atom").status_code == 200
