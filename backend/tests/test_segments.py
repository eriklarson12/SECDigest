"""Revenue by segment and geography from inline XBRL (roadmap 12.8).

The fixtures are real filings trimmed to their revenue facts, those facts' contexts and the period
fact. Every figure pinned here was checked against the printed table in the filing (roadmap 12.7)."""

from pathlib import Path

import pytest

from app.models.schemas import SegmentRevenue
from app.services import segments
from app.services.segments import member_label, parse_segments

FIXTURES = Path(__file__).parent / "fixtures" / "segments"
B = 1_000_000_000


def _parse(slug: str, form_type: str = "10-K") -> SegmentRevenue:
    return parse_segments((FIXTURES / f"{slug}.htm").read_text(), form_type)


def _rows(split) -> dict[str, float]:
    return {row.label: row.value for row in split.rows}


def test_aapl_reports_five_regions_and_three_countries():
    result = _parse("aapl_10k")
    assert (result.period_start, result.period_end) == ("2024-09-29", "2025-09-27")
    assert result.segments is not None and result.geography is not None
    assert result.segments.total == 416_161_000_000
    assert _rows(result.segments) == {
        "Americas": 178_353_000_000,
        "Europe": 111_032_000_000,
        "Greater China": 64_377_000_000,
        "Rest of Asia Pacific": 33_696_000_000,
        "Japan": 28_703_000_000,
    }
    assert result.segments.reconciling == []
    assert _rows(result.geography) == {
        "Other Countries": 199_994_000_000,
        "United States": 151_790_000_000,
        "China": 64_377_000_000,
    }


def test_rows_are_ranked_largest_first():
    split = _parse("aapl_10k").segments
    assert split is not None
    assert [row.label for row in split.rows][:2] == ["Americas", "Europe"]


def test_msft_tags_its_segment_axis_alone():
    result = _parse("msft_10k")
    assert result.segments is not None and result.geography is not None
    assert _rows(result.segments) == {
        "Productivity and Business Processes": 139_996_000_000,
        "Intelligent Cloud": 137_791_000_000,
        "More Personal Computing": 54_052_000_000,
    }
    assert _rows(result.geography) == {
        "United States": 170_794_000_000,
        "Outside the US": 161_045_000_000,
    }


def test_jpm_adds_up_only_with_its_corporate_and_reconciling_rows():
    split = _parse("jpm_10k").segments
    assert split is not None
    assert split.concept == "us-gaap:RevenuesNetOfInterestExpense"
    assert split.total == 182_447_000_000
    assert sum(_rows(split).values()) == 178_556_000_000
    assert {row.label: row.value for row in split.reconciling} == {
        "Corporate": 7_025_000_000,
        "Reconciling items": -3_134_000_000,
    }


def test_jpm_geography_drops_the_international_subtotal():
    geography = _parse("jpm_10k").geography
    assert geography is not None
    assert geography.concept == "us-gaap:Revenues"
    assert _rows(geography) == {
        "North America": 139_689_000_000,
        "EMEA": 24_478_000_000,
        "Asia Pacific": 14_065_000_000,
        "Latin America": 4_215_000_000,
    }


@pytest.mark.parametrize("slug", ["wkhs_10k", "pavm_10k"])
def test_a_single_segment_filer_is_computed_and_empty(slug):
    result = _parse(slug)
    assert (result.period_start, result.period_end) == ("2025-01-01", "2025-12-31")
    assert result.segments is None
    assert result.geography is None


def test_a_10q_reads_the_quarter_not_the_year_to_date():
    # The 10-Q's dei context runs 272 days; the quarter is the 90-day context ending the same day.
    result = _parse("aapl_10q", "10-Q")
    assert (result.period_start, result.period_end) == ("2026-03-29", "2026-06-27")
    assert result.segments is not None
    assert result.segments.total == pytest.approx(109.417 * B)
    assert sum(_rows(result.segments).values()) == result.segments.total
    assert result.geography is None


def test_a_document_without_inline_xbrl_has_no_period():
    assert parse_segments("<html><body><p>Revenue grew.</p></body></html>", "10-K") == (
        SegmentRevenue()
    )


# --- Synthetic documents: the rules no fixture happens to exercise ---

def _context(id: str, start: str, end: str, *dims: tuple[str, str]) -> str:
    members = "".join(
        f'<xbrldi:explicitMember dimension="{axis}">{member}</xbrldi:explicitMember>'
        for axis, member in dims
    )
    segment = f"<xbrli:segment>{members}</xbrli:segment>" if dims else ""
    return (
        f'<xbrli:context id="{id}"><xbrli:entity>{segment}</xbrli:entity><xbrli:period>'
        f"<xbrli:startDate>{start}</xbrli:startDate><xbrli:endDate>{end}</xbrli:endDate>"
        "</xbrli:period></xbrli:context>"
    )


def _fact(ctx: str, value: str, scale: int = 6, decimals: str = "-6", concept: str = "Revenues") -> str:
    return (
        f'<ix:nonFraction name="us-gaap:{concept}" contextRef="{ctx}" unitRef="usd" '
        f'decimals="{decimals}" scale="{scale}" format="ixt:num-dot-decimal">{value}</ix:nonFraction>'
    )


def _document(*members: tuple[str, str], extra: str = "") -> str:
    """A 10-K with a 300 total and one segment fact per (member, value)."""
    contexts = [_context("FY", "2025-01-01", "2025-12-31")]
    facts = [_fact("FY", "300")]
    for i, (member, value) in enumerate(members):
        contexts.append(
            _context(f"S{i}", "2025-01-01", "2025-12-31", (segments.SEGMENT_AXIS, member))
        )
        facts.append(_fact(f"S{i}", value))
    return (
        "<html><body><ix:header><ix:resources>" + "".join(contexts) + "</ix:resources></ix:header>"
        '<ix:nonNumeric name="dei:DocumentPeriodEndDate" contextRef="FY">December 31, 2025'
        "</ix:nonNumeric>" + "".join(facts) + extra + "</body></html>"
    )


def test_a_split_that_does_not_add_up_is_omitted():
    result = parse_segments(_document(("x:AMember", "100"), ("x:BMember", "150")), "10-K")
    assert result.period_end == "2025-12-31"
    assert result.segments is None


def test_a_split_within_one_percent_is_kept():
    result = parse_segments(_document(("x:AMember", "100"), ("x:BMember", "198")), "10-K")
    assert result.segments is not None
    assert result.segments.total == 300_000_000


def test_the_more_precise_of_two_duplicate_facts_wins():
    # WKHS tags its revenue twice, in thousands and in millions; the rounded copy must not win.
    precise = _fact("S0", "100,400", scale=3, decimals="-3")
    html = _document(("x:AMember", "100"), ("x:BMember", "200")).replace(
        "</body>", precise + "</body>"
    )
    split = parse_segments(html, "10-K").segments
    assert split is not None
    assert _rows(split)["A"] == 100_400_000


def test_a_negative_sign_attribute_is_applied():
    html = _document(("x:AMember", "400"), ("x:BMember", "100")).replace(
        'contextRef="S1"', 'contextRef="S1" sign="-"'
    )
    split = parse_segments(html, "10-K").segments
    assert split is not None
    assert _rows(split)["B"] == -100_000_000


def test_a_fact_with_a_third_axis_is_not_a_segment_row():
    third = _context(
        "S9", "2025-01-01", "2025-12-31",
        (segments.SEGMENT_AXIS, "x:AMember"), ("srt:ProductOrServiceAxis", "x:WidgetMember"),
    )
    html = _document(("x:AMember", "100"), ("x:BMember", "200")).replace(
        "</ix:resources>", third + "</ix:resources>"
    ).replace("</body>", _fact("S9", "50") + "</body>")
    split = parse_segments(html, "10-K").segments
    assert split is not None
    assert _rows(split) == {"A": 100_000_000, "B": 200_000_000}


def test_one_reported_segment_is_not_a_breakdown():
    assert parse_segments(_document(("x:AMember", "300")), "10-K").segments is None


@pytest.mark.parametrize(
    "member, label",
    [
        ("aapl:RestOfAsiaPacificSegmentMember", "Rest of Asia Pacific"),
        ("jpm:AssetandWealthManagementSegmentMember", "Asset and Wealth Management"),
        ("jpm:EMEAMember", "EMEA"),
        ("country:US", "United States"),
        ("country:ZZ", "ZZ"),
        ("srt:NonUsMember", "Outside the US"),
        ("us-gaap:CorporateNonSegmentMember", "Corporate"),
    ],
)
def test_member_labels(member, label):
    assert member_label(member) == label
