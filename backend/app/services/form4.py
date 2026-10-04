"""Open-market trades out of a Form 4's XML (roadmap 12.5). Pure, no I/O.

Form 4 XML is filed by the insider, not the issuer, so it is untrusted input: it is parsed with
defusedxml, which refuses entity expansion and external references."""

from __future__ import annotations

from xml.etree.ElementTree import Element

from defusedxml import DefusedXmlException
from defusedxml.ElementTree import ParseError, fromstring

from app.models.schemas import InsiderTransaction

_TRADE_CODES = ("P", "S")
_TRUE = ("1", "true")


def raw_document(primary_document: str) -> str:
    """The XML file behind a Form 4's primary document.

    The submissions feed names the XSLT rendering (`xslF345X06/form4.xml`), which is HTML. The raw
    XML is the same path without the stylesheet folder, whose version number changes over time."""
    return primary_document.rsplit("/", 1)[-1]


def _text(el: Element | None, path: str) -> str | None:
    if el is None:
        return None
    found = el.find(path)
    if found is None or found.text is None:
        return None
    return found.text.strip() or None


def _number(el: Element, path: str) -> float | None:
    raw = _text(el, path)
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _role(owner: Element | None) -> str:
    rel = owner.find("reportingOwnerRelationship") if owner is not None else None
    title = _text(rel, "officerTitle")
    if title:
        return title
    if _text(rel, "isDirector") in _TRUE:
        return "Director"
    if _text(rel, "isTenPercentOwner") in _TRUE:
        return "10% owner"
    return "Other"


def parse_form4(xml: bytes, accession_number: str, filing_date: str) -> list[InsiderTransaction]:
    """The P and S rows of one Form 4. Raises ValueError on malformed or hostile XML.

    A joint filing (a fund and its general partner, say) reports one trade under several owners;
    only the first is named, so the trade counts once."""
    try:
        root = fromstring(xml)
    except (ParseError, DefusedXmlException) as e:
        raise ValueError(f"unreadable Form 4 {accession_number}") from e

    owner = root.find("reportingOwner")
    name = _text(owner, "reportingOwnerId/rptOwnerName") or "Unknown"
    role = _role(owner)
    planned = _text(root, "aff10b5One") in _TRUE

    trades: list[InsiderTransaction] = []
    for row in root.findall("nonDerivativeTable/nonDerivativeTransaction"):
        code = _text(row, "transactionCoding/transactionCode")
        shares = _number(row, "transactionAmounts/transactionShares/value")
        if code not in _TRADE_CODES or shares is None:
            continue
        price = _number(row, "transactionAmounts/transactionPricePerShare/value")
        trades.append(
            InsiderTransaction(
                accession_number=accession_number,
                filing_date=filing_date,
                transaction_date=_text(row, "transactionDate/value"),
                owner_name=name,
                role=role,
                code="P" if code == "P" else "S",
                shares=shares,
                price=price,
                value=shares * price if price is not None else None,
                planned=planned,
            )
        )
    return trades
