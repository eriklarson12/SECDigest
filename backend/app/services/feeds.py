"""Atom feeds of new filings (roadmap 14.1). Pure: the router fetches, this renders."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from xml.sax.saxutils import escape, quoteattr

from app.models.schemas import Filing
from app.services.edgar import unpad_cik
from app.services.eightk import item_label

# Amendments are included: EDGAR matches form types exactly, and an 8-K/A is often a
# company's newest event (AAPL's, filed 2026-09-01).
FEED_FORMS = ["10-K", "10-Q", "8-K", "10-K/A", "10-Q/A", "8-K/A"]
MAX_ENTRIES = 20
# A tag URI never resolves, so it never breaks when a URL scheme changes; the date is when
# the authority was held, not when an entry was minted.
_TAG = "tag:secdigest.tech,2026"


@dataclass(frozen=True)
class FeedEntry:
    ticker: str
    cik: str
    company_name: str
    filing: Filing


def make_feed_id(tickers: list[str]) -> str:
    """Stable across ticker order, so a reordered watchlist is the same feed."""
    return f"{_TAG}:feed:{','.join(sorted(tickers))}"


def newest_first(entries: list[FeedEntry]) -> list[FeedEntry]:
    """Filing date, then accession: several filings a day share a date, and the
    accession's sequence number keeps their order stable between polls."""
    return sorted(
        entries,
        key=lambda e: (e.filing.filing_date, e.filing.accession_number.replace("-", "")),
        reverse=True,
    )[:MAX_ENTRIES]


def entry_title(entry: FeedEntry) -> str:
    title = f"{entry.ticker} {entry.filing.form_type}"
    if entry.filing.items:
        title += ": " + ", ".join(item_label(code) for code in entry.filing.items)
    return title


def edgar_index_url(cik: str, accession_number: str) -> str:
    """Same URL as `frontend/src/lib/edgar.ts`: unpadded CIK, dashless accession."""
    return (
        f"https://www.sec.gov/Archives/edgar/data/{unpad_cik(cik)}/"
        f"{accession_number.replace('-', '')}/"
    )


def _timestamp(filing_date: str) -> str:
    return f"{filing_date}T00:00:00Z"


def _entry_xml(entry: FeedEntry, site_url: str) -> str:
    filing = entry.filing
    accession = filing.accession_number.replace("-", "")
    company_url = f"{site_url}/company/{entry.ticker}"
    return f"""  <entry>
    <id>{_TAG}:filing:{accession}</id>
    <title>{escape(entry_title(entry))}</title>
    <updated>{_timestamp(filing.filing_date)}</updated>
    <author><name>{escape(entry.company_name)}</name></author>
    <link rel="alternate" type="text/html" href={quoteattr(edgar_index_url(entry.cik, accession))}/>
    <link rel="related" type="text/html" href={quoteattr(company_url)}/>
    <summary>{escape(f"{entry.company_name}, {filing.form_type}, filed {filing.filing_date}.")}</summary>
  </entry>
"""


def render_atom(
    *,
    feed_id: str,
    title: str,
    self_url: str,
    alternate_url: str,
    site_url: str,
    entries: list[FeedEntry],
) -> str:
    """`entries` MUST already be in `newest_first` order."""
    if entries:
        updated = _timestamp(entries[0].filing.filing_date)
    else:
        updated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    body = "".join(_entry_xml(entry, site_url) for entry in entries)
    return f"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>{escape(feed_id)}</id>
  <title>{escape(title)}</title>
  <updated>{updated}</updated>
  <author><name>SECDigest</name></author>
  <link rel="self" type="application/atom+xml" href={quoteattr(self_url)}/>
  <link rel="alternate" type="text/html" href={quoteattr(alternate_url)}/>
{body}</feed>
"""
