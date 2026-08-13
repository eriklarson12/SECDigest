"""Unit-scale detection (services/units.py).

The literal strings below are lifted from a real Costco 10-Q's stored chunks —
the filing that surfaced this gap by answering a liquidity question with
"$11,133" when it meant $11.1 billion.
"""

import pytest

from app.services import database, units


COSTCO_INCOME_STATEMENT = (
    "COSTCO WHOLESALE CORPORATION\n"
    "CONDENSED CONSOLIDATED STATEMENTS OF INCOME\n"
    "(amounts in millions, except per share data) (unaudited)\n"
    "12 Weeks Ended"
)
COSTCO_MDA = (
    "Management's Discussion and Analysis of Financial Condition and Results of "
    "Operations\n(amounts in millions, except per share, share, percentages and "
    "warehouse count data)"
)


def test_extracts_the_parenthetical_declaration():
    assert (
        units.extract_scale(COSTCO_INCOME_STATEMENT)
        == "Amounts in millions, except per share data."
    )


def test_keeps_the_exceptions_verbatim():
    """"except per share" is what stops a $1.30 dividend being read as $1.3M, so
    it must survive intact rather than be normalized to "millions"."""
    scale = units.extract_scale(COSTCO_MDA)
    assert scale == (
        "Amounts in millions, except per share, share, percentages and "
        "warehouse count data."
    )


def test_collapses_line_breaks_inside_the_declaration():
    """Filing text keeps the source document's line breaks; the caption is one line."""
    assert (
        units.extract_scale("BALANCE SHEETS\n(amounts\nin   thousands)\nMay 10")
        == "Amounts in thousands."
    )


@pytest.mark.parametrize(
    "text",
    [
        "Amounts are expressed in billions",
        "Dollars in thousands",
        "figures presented in millions",
    ],
)
def test_falls_back_to_a_prose_declaration(text):
    scale = units.extract_scale(text)
    assert scale is not None and scale.endswith(".")


@pytest.mark.parametrize(
    "text",
    [
        # A scale word with no declaration — the SQL prefilter matches these, so
        # the parser is what has to reject them.
        "One in millions of shoppers renews at a lower tier.",
        "Membership fee income rose across all markets.",
        "(unaudited)",
    ],
)
def test_prose_mentioning_a_scale_word_is_not_a_declaration(text):
    assert units.extract_scale(text) is None


def test_a_stray_paren_cannot_swallow_the_chunk():
    """The parenthetical pattern is bounded and newline-free, so an unclosed "("
    earlier in the chunk can't run on and capture half a page."""
    text = "(see Note 4\n" + "filler " * 200 + "\n(amounts in millions)"
    assert units.extract_scale(text) == "Amounts in millions."


async def test_scale_for_returns_the_first_chunk_that_parses(monkeypatch):
    """The prefilter matches "in millions" anywhere, so the first candidate is
    often prose; scale_for walks them in order rather than trusting the query."""

    async def candidates(accession_number, near_chunk_index, limit=3):
        return ["One in millions of shoppers.", COSTCO_MDA]

    monkeypatch.setattr(database, "find_scale_chunks", candidates)

    scale = await units.scale_for("0000909832260000051", 30)
    assert scale is not None and scale.startswith("Amounts in millions, except")


async def test_scale_for_passes_the_anchor_through(monkeypatch):
    seen = {}

    async def candidates(accession_number, near_chunk_index, limit=3):
        seen["accession"] = accession_number
        seen["near"] = near_chunk_index
        return [COSTCO_INCOME_STATEMENT]

    monkeypatch.setattr(database, "find_scale_chunks", candidates)

    await units.scale_for("000090983226000051", 30)
    assert seen == {"accession": "000090983226000051", "near": 30}


async def test_scale_for_is_none_when_the_filing_never_declares_one(monkeypatch):
    async def none(accession_number, near_chunk_index, limit=3):
        return []

    monkeypatch.setattr(database, "find_scale_chunks", none)
    assert await units.scale_for("000090983226000051", 3) is None


async def test_scale_for_swallows_lookup_failures(monkeypatch):
    """A caption is never worth failing a question the user already paid for."""

    async def boom(accession_number, near_chunk_index, limit=3):
        raise RuntimeError("supabase down")

    monkeypatch.setattr(database, "find_scale_chunks", boom)
    assert await units.scale_for("000090983226000051", 3) is None
