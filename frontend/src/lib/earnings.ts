/** Earnings-release summaries (roadmap 15.3): which events get the control, and its copy. */

import type { EarningsSummary, Filing } from "./types";

export const FOOTNOTE =
  "Summarized by Gemini from the press release (exhibit 99.1). A figure is shown only when its quote appears word for word in the release.";

/** An original 8-K reporting item 2.02. Amendments are excluded, as the backend excludes them. */
export function isEarningsRelease(event: Filing): boolean {
  return event.form_type === "8-K" && event.items.includes("2.02");
}

/** Stored summaries keyed by dashless accession: the feed's rows carry dashes, the table's do not. */
export function summaryByAccession(
  summaries: EarningsSummary[],
): Map<string, EarningsSummary> {
  return new Map(summaries.map((s) => [s.accession_number.replace(/-/g, ""), s]));
}

export function summaryFor(
  summaries: Map<string, EarningsSummary>,
  accession: string,
): EarningsSummary | null {
  return summaries.get(accession.replace(/-/g, "")) ?? null;
}

/** One label per state. Every state is one line, so a stored summary landing late moves nothing. */
export function buttonLabel({
  pending,
  open,
  hasSummary,
}: {
  pending: boolean;
  open: boolean;
  hasSummary: boolean;
}): string {
  if (pending) return "Summarizing…";
  if (open) return "Hide summary";
  return hasSummary ? "Show summary" : "Summarize";
}
