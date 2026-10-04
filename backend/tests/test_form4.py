"""The Form 4 parser (roadmap 12.5), pinned to real filings saved from EDGAR on 2026-10-03."""

from pathlib import Path

import pytest

from app.services.form4 import parse_form4, raw_document

FIXTURES = Path(__file__).parent / "fixtures" / "form4"


def parse(name: str):
    return parse_form4((FIXTURES / f"{name}.xml").read_bytes(), "acc", "2026-10-01")


def test_a_planned_sale():
    # AAPL, 0001140361-26-038307.
    [sale] = parse("aapl_sale")
    assert sale.owner_name == "Newstead Jennifer"
    assert sale.role == "SVP, GC and Government Affairs"
    assert sale.code == "S"
    assert sale.shares == 2399
    assert sale.price == 336.18
    assert sale.value == pytest.approx(2399 * 336.18)
    assert sale.transaction_date == "2026-09-29"
    assert sale.planned is True


def test_exercise_and_withholding_rows_are_not_trades():
    # AAPL, 0001140361-26-037020: an S beside an M (exercise) and an F (tax withholding).
    trades = parse("aapl_exercise")
    assert [(t.code, t.shares) for t in trades] == [("S", 1438)]


def test_an_open_market_purchase():
    # OXY, 0001628280-26-045313: the CEO, also a director, so the title wins over "Director".
    [buy] = parse("purchase")
    assert buy.code == "P"
    assert buy.role == "President and CEO"
    assert buy.shares == 4770
    assert buy.planned is False


def test_a_joint_filing_without_trades_has_no_rows():
    # WKHS, 0002097390-26-000008: three reporting owners, one non-trade (J) derivative row.
    assert parse("wkhs_joint") == []


def form4(relationship: str, row: str, plan: str = "0") -> bytes:
    return f"""<?xml version="1.0"?>
<ownershipDocument>
  <aff10b5One>{plan}</aff10b5One>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>Doe Jane</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship>{relationship}</reportingOwnerRelationship>
  </reportingOwner>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>Doe Fund LP</rptOwnerName></reportingOwnerId>
  </reportingOwner>
  <nonDerivativeTable><nonDerivativeTransaction>{row}</nonDerivativeTransaction></nonDerivativeTable>
</ownershipDocument>""".encode()


SALE = """<transactionDate><value>2026-09-01</value></transactionDate>
<transactionCoding><transactionCode>S</transactionCode></transactionCoding>
<transactionAmounts><transactionShares><value>100</value></transactionShares></transactionAmounts>"""


@pytest.mark.parametrize(
    "relationship, role",
    [
        ("<isDirector>1</isDirector><isTenPercentOwner>1</isTenPercentOwner>", "Director"),
        ("<isDirector>0</isDirector><isTenPercentOwner>true</isTenPercentOwner>", "10% owner"),
        ("<isOther>1</isOther>", "Other"),
    ],
)
def test_role_order_without_an_officer_title(relationship, role):
    [trade] = parse_form4(form4(relationship, SALE), "acc", "2026-09-02")
    assert trade.role == role
    assert trade.owner_name == "Doe Jane"


def test_a_sale_without_a_price_has_no_value():
    [trade] = parse_form4(form4("", SALE, plan="true"), "acc", "2026-09-02")
    assert trade.price is None
    assert trade.value is None
    assert trade.planned is True


def test_entity_expansion_is_refused():
    bomb = b"""<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>
<ownershipDocument><aff10b5One>&lol2;</aff10b5One></ownershipDocument>"""
    with pytest.raises(ValueError):
        parse_form4(bomb, "acc", "2026-09-02")


def test_malformed_xml_is_a_value_error():
    with pytest.raises(ValueError):
        parse_form4(b"<html>not a form</html", "acc", "2026-09-02")


@pytest.mark.parametrize(
    "primary, raw",
    [
        ("xslF345X06/form4.xml", "form4.xml"),
        ("xslF345X05/wk-form4_1787693344.xml", "wk-form4_1787693344.xml"),
        ("form4.xml", "form4.xml"),
    ],
)
def test_raw_document_drops_the_stylesheet_folder(primary, raw):
    assert raw_document(primary) == raw
