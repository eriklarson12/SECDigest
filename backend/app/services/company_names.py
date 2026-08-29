"""EDGAR company names, tidied for display.

EDGAR's `company_tickers.json` carries the filer name as registered, which
means ALL CAPS plus a trailing slash segment for the state or country of
incorporation and a few status markers: "COSTCO WHOLESALE CORP /NEW".

Two things this deliberately does not do. It does not strip /ADR, which says
the listing is a depositary receipt rather than the common stock. And it does
not try to recognise every acronym: no list covers 10,000 filers, so short
all-caps tokens are simply left alone.
"""

import re

_EDGAR_SUFFIXES = {
    "NEW", "OLD", "FI", "S", "CI", "DE", "CO", "CA", "NY", "NJ", "PA", "MD",
    "MA", "MN", "MI", "MO", "TX", "NV", "RI", "OH", "IL", "IN", "GA", "FL",
    "WA", "WI", "VA", "CT", "TN", "AZ", "OR", "OK", "KY", "LA", "AL", "AR",
    "IA", "KS", "ME", "MS", "MT", "NC", "ND", "NE", "NH", "NM", "SC", "SD",
    "UT", "VT", "WV", "WY", "AK", "HI", "ID", "DC", "PR", "CAN", "BC", "ON",
    "QC", "UK", "CAYMAN", "CAYMAN ISLANDS", "MARSHALL ISLANDS", "BERMUDA",
    "ISRAEL", "IRELAND", "SWITZERLAND", "NETHERLANDS", "LUXEMBOURG",
    "SINGAPORE", "ENGLAND", "SCOTLAND", "JAPAN", "CHINA", "BRAZIL", "MEXICO",
    "INDIA", "GREECE", "CYPRUS", "PANAMA", "JERSEY", "GUERNSEY", "MALTA",
}

_LEGAL_FORM_BEFORE_SLASH = {
    "SA", "S.A.", "NV", "N.V.", "AG", "BV", "B.V.", "AB", "SE", "OY", "AS",
}


def strip_edgar_suffix(name: str) -> str:
    out = name.strip()
    while True:
        m = re.search(r"(\s*)/\s*([^/]*?)\s*/?\s*$", out)
        if not m:
            break
        space_before, seg = m.group(1), m.group(2).strip()
        head = out[: m.start()].rstrip()
        # "Anheuser-Busch InBev SA/NV" is one Belgian legal form, not a Nevada
        # marker. The discriminator is the space: EDGAR writes its own suffix
        # with one ("ARM HOLDINGS PLC /UK"), a compound legal form without.
        if not space_before and head.split(" ")[-1].upper() in _LEGAL_FORM_BEFORE_SLASH:
            break
        if seg == "" or seg.upper() in _EDGAR_SUFFIXES:
            out = head
            continue
        break
    return out


# Title-casing an EDGAR name means deciding, per token, whether it is a word or
# an initialism, and no list covers 10,000 filers. So: a short all-caps token
# stays as it is unless it is a known corporate word. SPDR, ADM and GGL keep
# their shape; COSTCO and WHOLESALE do not. The cost is that a short brand
# (ETSY) stays capitalised, which reads fine.
_MIN_WORD_LEN = 4

_CORPORATE_WORDS = {
    "CORP", "INC", "CO", "THE", "AND", "OF", "FOR", "LTD", "GROUP", "TRUST",
    "FUND", "BANK", "OIL", "GAS", "NEW", "OLD", "AIR", "SUN", "SEA", "RED",
    "BLUE", "GOLD", "ONE", "TWO", "ALL", "BIG", "TOP", "KEY", "WAY", "BAY",
    "OAK", "CITY", "EAST", "WEST", "NORTH", "SOUTH", "LAND", "HOME", "LIFE",
    "CARE", "DATA", "TECH", "FOOD", "AUTO", "HOLD", "REAL", "FIRST", "STAR",
    "CAR", "BUS", "EYE", "ICE", "NET", "WEB", "BOX", "CUP", "PET", "TOY",
    "SKY", "ROW", "MAP", "LAB", "JET", "RAY", "ROCK", "IRON", "COAL", "WIND",
    "SOLAR", "GREEN", "WHITE", "BLACK", "SILVER", "RIVER", "LAKE", "HILL",
}

# Uppercase in, uppercase out. Legal forms that read as initialisms stay up;
# ones that read as words (Corp, Inc, Ltd) are in _CORPORATE_WORDS instead.
_KEEP_UPPER = {
    "LLC", "PLC", "LP", "LLP", "L.P.", "N.V.", "S.A.", "AG", "SA", "NV", "AB",
    "AS", "ASA", "BV", "GMBH", "KGAA", "SE", "SPA", "OYJ", "SAB", "CV", "ADR",
    "REIT", "ETF", "USA", "US", "UK", "II", "III", "IV", "VI", "VII", "VIII",
}

# The handful whose own capitalisation is well known and which no rule derives.
_SPECIAL_CASE = {
    "JPMORGAN": "JPMorgan",
    "NVIDIA": "NVIDIA",
    "IBM": "IBM",
    "EBAY": "eBay",
    "ETRADE": "E*TRADE",
    "PAYPAL": "PayPal",
    "YOUTUBE": "YouTube",
    "IPHONE": "iPhone",
    "MASTERCARD": "Mastercard",
    "SPDR": "SPDR",
    "ISHARES": "iShares",
    "POWERSHARES": "PowerShares",
    "VANECK": "VanEck",
    "WISDOMTREE": "WisdomTree",
    "BLACKROCK": "BlackRock",
    "MICROSTRATEGY": "MicroStrategy",
    "OPENAI": "OpenAI",
    "SALESFORCE": "Salesforce",
    "SOFI": "SoFi",
    "TSMC": "TSMC",
    "HSBC": "HSBC",
    "UBS": "UBS",
    "ING": "ING",
    "BBVA": "BBVA",
    "SAP": "SAP",
    "ASML": "ASML",
    "STMICROELECTRONICS": "STMicroelectronics",
    "LVMH": "LVMH",
    "AECOM": "AECOM",
    "AMETEK": "AMETEK",
    "ANSYS": "ANSYS",
    "AXA": "AXA",
}

_LOWER_PARTICLES = {"of", "and", "the", "for"}


def _cap_word(word: str) -> str:
    # "HOLDINGS/ADR" arrives as one token, so the check has to run per word too
    if word.upper() in _KEEP_UPPER:
        return word.upper()
    special = _SPECIAL_CASE.get(word.upper())
    if special:
        return special
    low = word.lower()
    if low.startswith("mc") and len(low) > 3:
        return "Mc" + low[2].upper() + low[3:]
    if low.startswith("o'") and len(low) > 2:
        return "O'" + low[2].upper() + low[3:]
    return low[0].upper() + low[1:]


def _fix_token(tok: str, first: bool) -> str:
    if not tok:
        return tok
    bare = tok.strip(".,()")
    special = _SPECIAL_CASE.get(bare.upper())
    if special:
        return tok.replace(bare, special)
    if bare.upper() in _KEEP_UPPER:
        return tok.upper()
    # A digit or an ampersand means the shape is deliberate: 3M, AT&T, S&P
    if any(c.isdigit() for c in tok) or "&" in tok or "*" in tok:
        return tok
    if not first and bare.lower() in _LOWER_PARTICLES:
        return tok.lower()
    letters = "".join(c for c in bare if c.isalpha())
    if (
        letters.isupper()
        and len(letters) < _MIN_WORD_LEN
        and bare.upper() not in _CORPORATE_WORDS
    ):
        return tok  # an initialism as far as anything here can tell
    return re.sub(r"[A-Za-z']+", lambda m: _cap_word(m.group()), tok)


def titlecase(name: str) -> str:
    # A name already carrying lowercase was written deliberately.
    letters = [c for c in name if c.isalpha()]
    if letters and not all(c.isupper() for c in letters):
        return name
    return " ".join(_fix_token(t, i == 0) for i, t in enumerate(name.split(" ")))


def clean_company_name(name: str) -> str:
    return titlecase(strip_edgar_suffix(name))
