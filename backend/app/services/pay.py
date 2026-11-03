"""The pay-versus-performance table out of a proxy's XBRL instance (roadmap 15.1). Pure, no I/O.

The instance is filer-built XML, so it is parsed with defusedxml, as Form 4s are. Concepts are
matched on local name because the `ecd` namespace carries a year (`ecd/2024`, `ecd/2025`).
Quirks measured on AAPL, SBUX and WKHS are in docs/edgar.md."""

from __future__ import annotations

import re
from typing import NamedTuple
from xml.etree.ElementTree import Element

from defusedxml import DefusedXmlException
from defusedxml.ElementTree import ParseError, fromstring

from app.models.schemas import PayExecutive, PayYear

_XBRLI = "{http://www.xbrl.org/2003/instance}"
_XBRLDI = "{http://xbrl.org/2006/xbrldi}"
_NIL = "{http://www.w3.org/2001/XMLSchema-instance}nil"

_INDIVIDUAL_AXIS = "IndividualAxis"
# Some filers also put the PEO amounts on this axis's PEO member; it says nothing more.
_CATEGORY_AXIS = "ExecutiveCategoryAxis"
_PEO_MEMBER = "PeoMember"

_TOTAL = "PeoTotalCompAmt"
_PAID = "PeoActuallyPaidCompAmt"
_NAME = "PeoName"
_TSR = "TotalShareholderRtnAmt"
_PEER_TSR = "PeerGroupTotalShareholderRtnAmt"
_MEASURE = "CoSelectedMeasureAmt"
_MEASURE_NAME = "CoSelectedMeasureName"
_CONCEPTS = {_TOTAL, _PAID, _NAME, _TSR, _PEER_TSR, _MEASURE, _MEASURE_NAME}


class ParsedPay(NamedTuple):
    measure_name: str | None
    years: list[PayYear]


class _Fact(NamedTuple):
    end: str
    member: str | None  # the IndividualAxis member, None when undimensioned
    text: str | None
    unit: str | None


def _local(name: str) -> str:
    """`{ns}Local` or `prefix:Local` → `Local`."""
    return name.rsplit("}", 1)[-1].rsplit(":", 1)[-1]


def _clean(text: str | None) -> str | None:
    if text is None:
        return None
    return " ".join(text.split()) or None


def _contexts(root: Element) -> dict[str, tuple[str, str | None]]:
    """Context id → (end date, IndividualAxis member). Contexts on any other axis are left out:
    those are the reconciliation rows (`AdjToCompAxis`) and the measure list (`MeasureAxis`)."""
    contexts: dict[str, tuple[str, str | None]] = {}
    for ctx in root.iter(f"{_XBRLI}context"):
        end = ctx.find(f".//{_XBRLI}endDate")
        if end is None:
            end = ctx.find(f".//{_XBRLI}instant")
        if end is None or not end.text:
            continue
        member: str | None = None
        other_axis = False
        for dim in ctx.iter():
            if dim.tag not in (f"{_XBRLDI}explicitMember", f"{_XBRLDI}typedMember"):
                continue
            axis = _local(dim.get("dimension", ""))
            value = _local(dim.text or "")
            if axis == _INDIVIDUAL_AXIS:
                member = value
            elif not (axis == _CATEGORY_AXIS and value == _PEO_MEMBER):
                other_axis = True
        if not other_axis:
            contexts[ctx.get("id", "")] = (end.text.strip(), member)
    return contexts


def _units(root: Element) -> dict[str, str]:
    units: dict[str, str] = {}
    for unit in root.iter(f"{_XBRLI}unit"):
        measures = [_local(m.text or "") for m in unit.iter(f"{_XBRLI}measure")]
        if unit.find(f"{_XBRLI}divide") is not None:
            label = "USD/share" if measures == ["USD", "shares"] else "/".join(measures)
        else:
            label = measures[0] if measures else ""
        units[unit.get("id", "")] = label
    return units


def _facts(root: Element) -> dict[str, list[_Fact]]:
    contexts = _contexts(root)
    units = _units(root)
    facts: dict[str, list[_Fact]] = {concept: [] for concept in _CONCEPTS}
    seen: set[tuple[str, str]] = set()
    for el in root:
        concept = _local(el.tag)
        if concept not in _CONCEPTS or "/ecd/" not in el.tag:
            continue
        ref = el.get("contextRef", "")
        # AAPL repeats its latest year's facts; the first is as good as the second.
        if ref not in contexts or (concept, ref) in seen:
            continue
        seen.add((concept, ref))
        end, member = contexts[ref]
        text = None if el.get(_NIL) == "true" else _clean(el.text)
        unit = units.get(el.get("unitRef", "")) if el.get("unitRef") else None
        facts[concept].append(_Fact(end, member, text, unit))
    return facts


def _number(text: str | None) -> float | None:
    if text is None:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _member_name(member: str) -> str:
    """`BrianNiccolMember` → `Brian Niccol`, for a PEO with no `PeoName` fact."""
    base = member.removesuffix("Member")
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", base)


def _year_value(facts: list[_Fact], end: str) -> _Fact | None:
    return next((f for f in facts if f.end == end and f.member is None), None)


def _executives(facts: dict[str, list[_Fact]], end: str) -> list[PayExecutive]:
    names_by_member = {f.member: f.text for f in facts[_NAME] if f.member and f.text}
    plain_names = [f for f in facts[_NAME] if f.member is None and f.text]
    # AAPL tags its amounts undimensioned but the name on `CookMember`, so a sole named
    # member is the PEO those amounts belong to.
    sole_member = next(iter(names_by_member.values())) if len(names_by_member) == 1 else None
    plain_name = (
        next((f.text for f in plain_names if f.end == end), None)
        or sole_member
        or next((f.text for f in plain_names), None)
    )

    amounts: dict[str | None, dict[str, float | None]] = {}
    for concept in (_TOTAL, _PAID):
        for f in facts[concept]:
            if f.end == end:
                amounts.setdefault(f.member, {})[concept] = _number(f.text)

    named: list[PayExecutive] = []
    for member, values in amounts.items():
        total, paid = values.get(_TOTAL), values.get(_PAID)
        # A filer with several PEOs tags every one in every year, with 0 for the years they
        # were not PEO (SBUX).
        if member is None or not (total or paid):
            continue
        name = names_by_member.get(member) or _member_name(member)
        named.append(PayExecutive(name=name, total_comp=total, comp_actually_paid=paid))
    if named:
        return named

    plain = amounts.get(None)
    if plain is None:
        return []
    return [
        PayExecutive(
            name=plain_name,
            total_comp=plain.get(_TOTAL),
            comp_actually_paid=plain.get(_PAID),
        )
    ]


def parse_pay_versus_performance(xml: bytes) -> ParsedPay:
    """The tagged table, newest year first. Raises ValueError on malformed or hostile XML.

    Net income is deliberately not read: SBUX tags it in unscaled millions, so it comes from the
    10-K figures instead."""
    try:
        root = fromstring(xml)
    except (ParseError, DefusedXmlException) as e:
        raise ValueError("unreadable proxy XBRL instance") from e

    facts = _facts(root)
    ends = {f.end for concept in (_TOTAL, _PAID, _TSR) for f in facts[concept]}
    years: list[PayYear] = []
    for end in sorted(ends, reverse=True):
        measure = _year_value(facts[_MEASURE], end)
        tsr = _year_value(facts[_TSR], end)
        peer = _year_value(facts[_PEER_TSR], end)
        years.append(
            PayYear(
                period_end=end,
                executives=_executives(facts, end),
                tsr=_number(tsr.text) if tsr else None,
                peer_tsr=_number(peer.text) if peer else None,
                measure_value=_number(measure.text) if measure else None,
                measure_unit=measure.unit if measure else None,
            )
        )

    names = sorted(
        (f for f in facts[_MEASURE_NAME] if f.member is None and f.text),
        key=lambda f: f.end,
        reverse=True,
    )
    return ParsedPay(measure_name=names[0].text if names else None, years=years)
