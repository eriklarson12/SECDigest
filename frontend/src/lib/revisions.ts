/** Presentation rules for revised XBRL figures (roadmap 9.3).
 *
 * Kept out of the component so it can be tested: Vitest here runs in a node environment against
 * `.test.ts` files only, with no jsdom and no React testing library. The rendered states are
 * Playwright's. */

/** Metric keys the backend emits, in reading order. It names the metric rather than leaving the
 * frontend to infer one from the us-gaap tag: only the series selection knows which concept was
 * chosen for which line, and a filer can move between tags mid-history. */
export const METRIC_LABELS: Record<string, string> = {
  revenue: "Revenue",
  net_income: "Net Income",
  operating_cash_flow: "Operating Cash Flow",
};

/** An unmapped metric renders as its own key rather than being dropped — same posture as an
 * unmapped 8-K item code in `lib/eightk.ts`. */
export function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}

/** Signed, one decimal. The sign is carried in the text and paired with an arrow at the call
 * site, never conveyed by colour: a revision has a direction but no goodness, so `positive` and
 * `negative` (which mean good and bad) stay on `Delta` where they belong. */
export function formatRevisionDelta(pct: number): string {
  const rounded = pct.toFixed(1);
  return `${pct > 0 ? "+" : ""}${rounded}%`;
}

/** ▲ up, ▼ down. Read alongside the sign, so neither is the only cue. */
export function revisionArrow(pct: number): string {
  return pct > 0 ? "▲" : "▼";
}
