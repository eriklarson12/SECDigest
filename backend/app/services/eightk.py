"""8-K item labels for the Atom feeds (roadmap 14.1).

A copy of `ITEM_LABELS` in `frontend/src/lib/eightk.ts`, which is the source: edit that map
first and mirror it here. A feed reader shows an entry's title and nothing else, so the
labels have to be written into the feed rather than left to the frontend.
`tests/test_feeds.py` fails when the two maps differ."""

ITEM_LABELS: dict[str, str] = {
    "1.01": "Material Agreement Entered",
    "1.02": "Material Agreement Terminated",
    "1.03": "Bankruptcy or Receivership",
    "1.04": "Mine Safety Shutdowns",
    "1.05": "Material Cybersecurity Incident",
    "2.01": "Acquisition or Disposition Completed",
    "2.02": "Results of Operations",
    "2.03": "Direct Financial Obligation Created",
    "2.04": "Financial Obligation Accelerated",
    "2.05": "Exit or Disposal Costs",
    "2.06": "Material Impairment",
    "3.01": "Delisting Notice or Listing Transfer",
    "3.02": "Unregistered Sale of Equity",
    "3.03": "Security Holder Rights Modified",
    "4.01": "Change of Accountant",
    "4.02": "Non-Reliance on Prior Financials",
    "5.01": "Change in Control",
    "5.02": "Departure or Election of Directors or Officers",
    "5.03": "Charter, Bylaw or Fiscal Year Change",
    "5.04": "Benefit Plan Trading Suspension",
    "5.05": "Code of Ethics Amendment or Waiver",
    "5.06": "Shell Company Status Change",
    "5.07": "Submission of Matters to a Vote",
    "5.08": "Shareholder Director Nominations",
    "7.01": "Regulation FD Disclosure",
    "8.01": "Other Events",
    "9.01": "Exhibits",
}


def item_label(code: str) -> str:
    """What a code means, or the code itself when it is not in the map. Never dropped:
    the SEC adds items without notice."""
    return ITEM_LABELS.get(code, f"Item {code}")
