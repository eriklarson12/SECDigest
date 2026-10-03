/** The "what changed" page (roadmap 12.2): every rule that picks or windows data, kept out of the
 * components so it can be tested. Vitest runs in a node environment against `.test.ts` files only. */

import { EVENT_FORMS } from "./eightk";
import { formatDate } from "./format";
import type {
  AnalysisResponse,
  AnnualFinancials,
  Filing,
  FinancialsResponse,
  QuarterlyFinancials,
  Revision,
} from "./types";

/** A 10-K is due 60 to 90 days after year end and a 10-Q 40 to 45 after quarter end; 150 days
 * leaves room for a late filer and still cannot reach the period before. */
const PERIOD_WINDOW_DAYS = 150;
const DAY_MS = 86_400_000;

function days(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

/** The row whose period ended within the window before `filingDate`, latest first. */
export function periodFor<T extends { period_end?: string | null }>(
  rows: T[],
  filingDate: string,
): T | null {
  const filed = days(filingDate);
  let best: T | null = null;
  for (const row of rows) {
    if (!row.period_end) continue;
    const age = filed - days(row.period_end);
    if (age < 0 || age >= PERIOD_WINDOW_DAYS) continue;
    if (!best || row.period_end > best.period_end!) best = row;
  }
  return best;
}

export type MetricFormat = "currency" | "eps";

export interface HeadlineRow {
  label: string;
  format: MetricFormat;
  prior: number | null;
  current: number | null;
  /** Null when either side is missing or the prior is not positive: a change off a loss has no
   * honest percentage. */
  changePct: number | null;
}

export type Headline =
  | { kind: "missing" }
  | {
      kind: "ready";
      priorLabel: string;
      currentLabel: string;
      rows: HeadlineRow[];
      /** Quarterly XBRL here carries revenue and net income only. */
      annual: boolean;
    };

function row(
  label: string,
  format: MetricFormat,
  prior: number | null,
  current: number | null,
): HeadlineRow {
  const changePct =
    prior !== null && current !== null && prior > 0
      ? ((current - prior) / prior) * 100
      : null;
  return { label, format, prior, current, changePct };
}

function annualLabel(year: AnnualFinancials): string {
  return `FY${year.fiscal_year}`;
}

function quarterLabel(quarter: QuarterlyFinancials): string {
  return `Quarter ended ${formatDate(quarter.period_end)}`;
}

/** Both periods' figures from the financials payload. Missing when either filing's period has no
 * row: half a comparison is not one. */
export function headline(
  analysis: AnalysisResponse,
  prior: AnalysisResponse,
  financials: FinancialsResponse,
): Headline {
  if (!analysis.filing_date || !prior.filing_date) return { kind: "missing" };

  if (analysis.form_type.startsWith("10-K")) {
    const a = periodFor(financials.years, analysis.filing_date);
    const b = periodFor(financials.years, prior.filing_date);
    if (!a || !b || a === b) return { kind: "missing" };
    return {
      kind: "ready",
      priorLabel: annualLabel(b),
      currentLabel: annualLabel(a),
      annual: true,
      rows: [
        row("Revenue", "currency", b.revenue, a.revenue),
        row("Net income", "currency", b.net_income, a.net_income),
        row("Diluted EPS", "eps", b.eps_diluted, a.eps_diluted),
        row(
          "Operating cash flow",
          "currency",
          b.operating_cash_flow,
          a.operating_cash_flow,
        ),
      ],
    };
  }

  const quarters = financials.quarters ?? [];
  const a = periodFor(quarters, analysis.filing_date);
  const b = periodFor(quarters, prior.filing_date);
  if (!a || !b || a === b) return { kind: "missing" };
  return {
    kind: "ready",
    priorLabel: quarterLabel(b),
    currentLabel: quarterLabel(a),
    annual: false,
    rows: [
      row("Revenue", "currency", b.revenue, a.revenue),
      row("Net income", "currency", b.net_income, a.net_income),
    ],
  };
}

/** 8-Ks filed after the prior filing and on or before this one, newest first. The bounds are
 * half-open on purpose: an earnings 8-K filed the same day as the prior 10-Q belongs to it.
 *
 * `truncated` says the scan stopped inside the window: the response hit `limit` and its oldest
 * row is still newer than the prior filing, so older events may exist unseen. */
export function eventsBetween(
  filings: Filing[],
  priorDate: string,
  newDate: string,
  limit: number,
): { events: Filing[]; truncated: boolean } {
  const forms: readonly string[] = EVENT_FORMS;
  const events = filings.filter(
    (f) =>
      forms.includes(f.form_type) &&
      f.filing_date > priorDate &&
      f.filing_date <= newDate,
  );
  const oldest = filings.reduce<string | null>(
    (min, f) => (min === null || f.filing_date < min ? f.filing_date : min),
    null,
  );
  const truncated =
    filings.length >= limit && oldest !== null && oldest > priorDate;
  return { events, truncated };
}

const dashless = (accession: string) => accession.replace(/-/g, "");

/** Revisions this filing made: the figure's latest report is this accession. The payload keeps
 * only the first and latest report, so a figure revised again later drops off older pairs.
 * Compared without dashes: XBRL writes `0000320193-25-000079`, stored analyses `000032019325000079`. */
export function revisionsBy(
  revisions: Revision[],
  accession: string,
): Revision[] {
  const own = dashless(accession);
  return revisions.filter((r) => dashless(r.latest_accn) === own);
}
