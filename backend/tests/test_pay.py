"""Pay versus performance (roadmap 15.1): the parser on three real proxies, and request cost."""

from pathlib import Path

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app.main import app
from app.services import edgar
from app.services.pay import parse_pay_versus_performance

client = TestClient(app, raise_server_exceptions=False)

FIXTURES = Path(__file__).parent / "fixtures" / "pay"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK0000320193.json"
FOLDER = "https://www.sec.gov/Archives/edgar/data/320193/000130817926000008/"
INSTANCE_URL = FOLDER + "aapl014016-def14a_htm.xml"


def fixture(name: str) -> bytes:
    return (FIXTURES / f"{name}.xml").read_bytes()


def submissions(forms: list[str]) -> dict:
    return {
        "filings": {
            "recent": {
                "form": forms,
                "accessionNumber": ["0001308179-26-000008"] * len(forms),
                "filingDate": ["2026-01-08"] * len(forms),
                "primaryDocument": ["aapl014016-def14a.htm"] * len(forms),
                "primaryDocDescription": [""] * len(forms),
                "items": [""] * len(forms),
            }
        }
    }


def mock_feed(forms: list[str] | None = None) -> None:
    respx.get(SUBMISSIONS_URL).mock(
        return_value=httpx.Response(200, json=submissions(forms or ["8-K", "DEF 14A"]))
    )


def executives(year) -> list[tuple[str, float | None, float | None]]:
    return [(e.name, e.total_comp, e.comp_actually_paid) for e in year.executives]


# --- parser ---


def test_one_undimensioned_peo_takes_the_name_tagged_on_his_member():
    parsed = parse_pay_versus_performance(fixture("aapl"))
    assert parsed.measure_name == "Net Sales"
    assert [y.period_end for y in parsed.years] == [
        "2025-09-27",
        "2024-09-28",
        "2023-09-30",
        "2022-09-24",
        "2021-09-25",
    ]
    latest = parsed.years[0]
    # The latest year's facts appear twice in the instance; one row comes out.
    assert executives(latest) == [("Mr. Cook", 74_294_811, 108_423_733)]
    assert (latest.tsr, latest.peer_tsr) == (233.88, 279.51)
    assert (latest.measure_value, latest.measure_unit) == (416_161_000_000, "USD")


def test_several_peos_drop_their_zero_years():
    parsed = parse_pay_versus_performance(fixture("sbux"))
    by_end = {y.period_end: y for y in parsed.years}
    assert executives(by_end["2024-09-29"]) == [
        ("Laxman Narasimhan", 21_530_692, 5_709_978),
        ("Rachel Ruggeri", 6_627_008, 3_900_195),
        ("Brian Niccol", 95_801_676, 96_434_632),
    ]
    # Ruggeri's FY2025 is tagged 0 and nil; she was not PEO that year.
    assert executives(by_end["2025-09-28"]) == [("Brian Niccol", 30_992_773, 3_634_603)]
    assert executives(by_end["2022-10-02"])[0] == ("Kevin Johnson", 16_718_154, -2_892_677)


def test_the_measure_unit_is_reported_as_tagged():
    parsed = parse_pay_versus_performance(fixture("sbux"))
    assert parsed.measure_name == "Adjusted EPS"
    # Adjusted EPS, tagged as a pure number rather than USD per share.
    assert (parsed.years[0].measure_value, parsed.years[0].measure_unit) == (2.15, "pure")


def test_a_smaller_reporting_company_has_three_years_and_no_peer_or_measure():
    parsed = parse_pay_versus_performance(fixture("wkhs"))
    assert parsed.measure_name is None
    assert [y.period_end for y in parsed.years] == ["2025-12-31", "2024-12-31", "2023-12-31"]
    assert all(y.peer_tsr is None and y.measure_value is None for y in parsed.years)
    assert [e.name for e in parsed.years[0].executives] == ["Richard Dauch", "Scott Griffith"]
    assert executives(parsed.years[2]) == [("Richard Dauch", 3_388_174, -409_935)]
    assert parsed.years[0].tsr == 0.11


def test_a_sole_peo_with_no_name_tagged_has_a_null_name():
    # MSFT and GOOGL: one PEO, amounts undimensioned, and no PeoName fact anywhere.
    xml = b"""<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance"
        xmlns:ecd="http://xbrl.sec.gov/ecd/2025">
      <xbrli:context id="c0"><xbrli:period><xbrli:startDate>2025-07-01</xbrli:startDate>
        <xbrli:endDate>2026-06-30</xbrli:endDate></xbrli:period></xbrli:context>
      <xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
      <ecd:PeoTotalCompAmt contextRef="c0" unitRef="usd">90628977</ecd:PeoTotalCompAmt>
    </xbrli:xbrl>"""
    parsed = parse_pay_versus_performance(xml)
    assert executives(parsed.years[0]) == [(None, 90_628_977, None)]


@pytest.mark.parametrize(
    "xml",
    [
        b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "boom">]><x>&a;</x>',
        b"<xbrli:xbrl",
    ],
    ids=["entity", "malformed"],
)
def test_hostile_or_broken_xml_raises_value_error(xml):
    with pytest.raises(ValueError):
        parse_pay_versus_performance(xml)


# --- service and endpoint ---


@respx.mock
async def test_cold_costs_two_requests_and_warm_costs_none():
    mock_feed()
    respx.get(INSTANCE_URL).mock(return_value=httpx.Response(200, content=fixture("aapl")))
    result = await edgar.get_pay_versus_performance("320193")
    assert result.accession_number == "0001308179-26-000008"
    assert result.filing_date == "2026-01-08"
    assert len(result.years) == 5
    assert len(respx.calls) == 2

    await edgar.get_pay_versus_performance("320193")
    assert len(respx.calls) == 2


@respx.mock
async def test_a_differently_named_instance_is_found_through_the_index():
    mock_feed()
    respx.get(INSTANCE_URL).mock(return_value=httpx.Response(404))
    respx.get(FOLDER + "index.json").mock(
        return_value=httpx.Response(
            200,
            json={"directory": {"item": [{"name": "proxy.htm"}, {"name": "proxy2026_htm.xml"}]}},
        )
    )
    respx.get(FOLDER + "proxy2026_htm.xml").mock(
        return_value=httpx.Response(200, content=fixture("aapl"))
    )
    result = await edgar.get_pay_versus_performance("320193")
    assert len(result.years) == 5
    assert len(respx.calls) == 4  # feed, the 404, the index, the instance


@respx.mock
async def test_an_untagged_proxy_is_an_empty_cached_result():
    mock_feed()
    respx.get(INSTANCE_URL).mock(return_value=httpx.Response(404))
    respx.get(FOLDER + "index.json").mock(
        return_value=httpx.Response(200, json={"directory": {"item": [{"name": "proxy.htm"}]}})
    )
    result = await edgar.get_pay_versus_performance("320193")
    assert result.accession_number == "0001308179-26-000008"
    assert result.years == []
    cold = len(respx.calls)
    await edgar.get_pay_versus_performance("320193")
    assert len(respx.calls) == cold


@respx.mock
async def test_no_proxy_is_empty_with_no_accession():
    mock_feed(["10-K", "8-K"])
    result = await edgar.get_pay_versus_performance("320193")
    assert result.accession_number is None
    assert result.years == []
    assert len(respx.calls) == 1


@respx.mock
def test_endpoint_returns_the_table():
    mock_feed()
    respx.get(INSTANCE_URL).mock(return_value=httpx.Response(200, content=fixture("aapl")))
    response = client.get("/api/companies/320193/pay")
    assert response.status_code == 200
    body = response.json()
    assert body["cik"] == "0000320193"
    assert body["years"][0]["executives"][0]["name"] == "Mr. Cook"


def test_endpoint_rejects_a_bad_cik():
    assert client.get("/api/companies/abc/pay").status_code == 422


@respx.mock
def test_endpoint_502s_and_does_not_cache_a_failed_feed():
    route = respx.get(SUBMISSIONS_URL).mock(return_value=httpx.Response(404))
    assert client.get("/api/companies/320193/pay").status_code == 502
    assert client.get("/api/companies/320193/pay").status_code == 502
    assert route.call_count == 2


@respx.mock
def test_endpoint_502s_on_an_unreadable_instance():
    mock_feed()
    respx.get(INSTANCE_URL).mock(return_value=httpx.Response(200, content=b"<xbrli:xbrl"))
    assert client.get("/api/companies/320193/pay").status_code == 502
