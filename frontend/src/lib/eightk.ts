/** 8-K event codes (roadmap 9.2) — the label map and the split, kept out of the components so
 * they can be tested. Vitest here runs in a node environment against `.test.ts` files only.
 *
 * The map is presentation data and lives in the frontend rather than beside the parser in
 * `services/edgar.py`: the backend's job is to report what EDGAR said, and what a code means to
 * a reader is a wording decision that changes without the wire format changing. */

import type { Filing } from "./types";

/** The form types that carry item codes. Amendments are included because they are real events
 * and sometimes the newest one — AAPL's latest as of 2026-09-06 is an 8-K/A. EDGAR matches form
 * types exactly, so `8-K/A` has to be asked for by name. */
export const EVENT_FORMS = ["8-K", "8-K/A"] as const;

/** How many rows the company page requests when it needs events too. Reaching 10 periodic
 * filings means walking past the 8-Ks between them: measured at depth 28 for BRK.A, 32 for AAPL
 * and 57 for SMCI, so this is headroom over the worst case rather than a round number. */
export const EVENT_SCAN_LIMIT = 100;

/** Rows shown in either section. Both are capped: the strip is a summary, not an archive. */
export const MAX_EVENTS = 10;
export const MAX_FILINGS = 10;

/** Form 8-K's item set, shortened to fit one line beside a date. The full SEC captions run past
 * 140 characters ("Triggering Events That Accelerate or Increase a Direct Financial
 * Obligation…"), and a filing can carry seven of them at once.
 *
 * Regulation AB's 6.01-6.05 are asset-backed issuers only and are deliberately absent — an
 * operating company never files them, and an unmapped code renders honestly anyway. */
export const ITEM_LABELS: Record<string, string> = {
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
};

/** What a code means, or the code itself when it is not in the map.
 *
 * Never dropped: the SEC adds items without notice — 1.05 arrived with the 2023 cybersecurity
 * rules — and a silently missing event reads as a filing that said nothing. */
export function itemLabel(code: string): string {
  return ITEM_LABELS[code] ?? `Item ${code}`;
}

export function isEvent(formType: string): boolean {
  return formType.startsWith("8-K");
}

/** One filing's items as a single readable line, or null when it carries none.
 *
 * A middot line and not chips, for the reason `docs/design-system.md` gives three times over: a
 * `whitespace-nowrap` pill overflows 375px, and these labels are longer than the SIC descriptions
 * that produced that rule. Codes are sorted so 9.01 trails — it rides along on 83% of 8-Ks and
 * says nothing about what happened, so it must never be the first thing read. */
export function eventSummary(items: string[]): string | null {
  if (items.length === 0) return null;
  return [...items]
    .sort()
    .map(itemLabel)
    .join(" · ");
}

/** The two readings of one filings response.
 *
 * The company page asks for periodic forms and event forms together and splits here, so the
 * events strip costs no second request against EDGAR — where the submissions document runs to
 * 4.5 MB for a filer like JPM. */
export function splitFilings(rows: Filing[]): {
  periodic: Filing[];
  events: Filing[];
} {
  const periodic: Filing[] = [];
  const events: Filing[] = [];
  for (const row of rows) {
    if (isEvent(row.form_type)) events.push(row);
    else periodic.push(row);
  }
  return {
    periodic: periodic.slice(0, MAX_FILINGS),
    events: events.slice(0, MAX_EVENTS),
  };
}
