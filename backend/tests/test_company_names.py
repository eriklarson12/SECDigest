"""EDGAR names carry the state of incorporation and a few status markers as a
trailing slash segment, and arrive in ALL CAPS. Both are display artifacts."""

import pytest

from app.services.company_names import (
    clean_company_name,
    strip_edgar_suffix,
    titlecase,
)


@pytest.mark.parametrize(
    "raw,expected",
    [
        # The reported case: /NEW marks a re-registered entity
        ("COSTCO WHOLESALE CORP /NEW", "COSTCO WHOLESALE CORP"),
        ("APPLIED MATERIALS INC /DE", "APPLIED MATERIALS INC"),
        # EDGAR sometimes closes the segment as well
        ("BANK OF AMERICA CORP /DE/", "BANK OF AMERICA CORP"),
        ("FNB CORP/PA/", "FNB CORP"),
        # A bare trailing slash is a dangling separator
        ("TOYOTA MOTOR CORP/", "TOYOTA MOTOR CORP"),
        # No space before the slash is still a suffix when the head is not a
        # legal form
        ("QUALCOMM INC/DE", "QUALCOMM INC"),
        ("WELLS FARGO & COMPANY/MN", "WELLS FARGO & COMPANY"),
        ("FAIRFAX FINANCIAL HOLDINGS LTD/ CAN", "FAIRFAX FINANCIAL HOLDINGS LTD"),
    ],
)
def test_strips_edgar_suffixes(raw, expected):
    assert strip_edgar_suffix(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        # /ADR says the listing is a depositary receipt, not the common stock
        "Kioxia Holdings Corporation/ADR",
        "SUNEVISION HOLDINGS/ADR",
        # SA/NV is one Belgian legal form. The space is the discriminator:
        # EDGAR writes its own suffix with one, a compound legal form without.
        "Anheuser-Busch InBev SA/NV",
        # A long segment is part of the name, not a marker
        "RiverNorth /DoubleLine Strategic Opportunity Fund, Inc.",
    ],
)
def test_keeps_meaningful_slash_segments(raw):
    assert strip_edgar_suffix(raw) == raw


def test_a_spaced_suffix_after_a_legal_form_is_still_stripped():
    """PLC is the company's own form; the /UK after it is EDGAR's marker."""
    assert strip_edgar_suffix("ARM HOLDINGS PLC /UK") == "ARM HOLDINGS PLC"


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("COSTCO WHOLESALE CORP", "Costco Wholesale Corp"),
        ("BERKSHIRE HATHAWAY INC", "Berkshire Hathaway Inc"),
        # Particles stay lowercase, but never as the first word
        ("BANK OF AMERICA CORP", "Bank of America Corp"),
        ("THE SOUTHERN CO", "The Southern Co"),
        # Legal forms that read as initialisms stay up; ones that read as
        # words do not
        ("BARCLAYS BANK PLC", "Barclays Bank PLC"),
        ("WIPRO LTD", "Wipro Ltd"),
        ("PLAINS ALL AMERICAN PIPELINE LP", "Plains All American Pipeline LP"),
        # Digits and ampersands mean the shape is deliberate
        ("3M CO", "3M Co"),
        ("AT&T INC.", "AT&T Inc."),
        ("SPDR S&P 500 ETF TRUST", "SPDR S&P 500 ETF Trust"),
        # Roman numerals
        ("WESTERN ASSET HIGH INCOME FUND II INC.", "Western Asset High Income Fund II Inc."),
        ("MCDONALDS CORP", "McDonalds Corp"),
    ],
)
def test_titlecases_all_caps_names(raw, expected):
    assert titlecase(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        # Short all-caps tokens are left alone: no list covers 10,000 filers,
        # so guessing costs more than it buys.
        "ADM TRONICS UNLIMITED, INC.",
        "GGL RESOURCES CORP.",
    ],
)
def test_leaves_short_all_caps_tokens_alone(raw):
    first = titlecase(raw).split(" ")[0]
    assert first == raw.split(" ")[0]


def test_a_name_already_carrying_lowercase_is_left_alone():
    """Mixed case in the source was written deliberately."""
    assert titlecase("iShares Gold Trust") == "iShares Gold Trust"
    assert titlecase("Anheuser-Busch InBev SA/NV") == "Anheuser-Busch InBev SA/NV"


def test_end_to_end():
    assert clean_company_name("COSTCO WHOLESALE CORP /NEW") == "Costco Wholesale Corp"
    assert clean_company_name("JPMORGAN CHASE & CO") == "JPMorgan Chase & Co"
    assert clean_company_name("NVIDIA CORP") == "NVIDIA Corp"


def test_is_idempotent():
    """Names are cleaned both at the EDGAR boundary and on read from the
    database, so a stored-then-reread name must not drift."""
    for raw in [
        "COSTCO WHOLESALE CORP /NEW",
        "Kioxia Holdings Corporation/ADR",
        "AT&T INC.",
        "BANK OF AMERICA CORP /DE/",
    ]:
        once = clean_company_name(raw)
        assert clean_company_name(once) == once


def test_handles_empty_and_degenerate_input():
    assert clean_company_name("") == ""
    assert clean_company_name("   ") == ""
    assert clean_company_name("/") == ""
