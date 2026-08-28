/** Shared XBRL → chart-point transforms (AnalysisDashboard + the company page). */

import { formatDate } from "./format";
import type {
  AnnualFinancials,
  QuarterlyFinancials,
  TrendPoint,
} from "./types";

/** True when a year has data beyond revenue/net income (the chart's job) — per-share,
 * cash-flow, or balance-sheet figures. Shared so the table and its two call sites agree. */
export function hasAnnualMetrics(years: AnnualFinancials[]): boolean {
  return years.some(
    (y) =>
      y.eps_diluted != null ||
      y.operating_cash_flow != null ||
      y.cash != null ||
      y.total_assets != null ||
      y.stockholders_equity != null,
  );
}

/** Exact XBRL annual figures → chart points; drops years with no usable data. */
export function buildAnnualPoints(years: AnnualFinancials[]): TrendPoint[] {
  return years
    .filter((y) => y.revenue !== null || y.net_income !== null)
    .map((y) => ({
      label: `FY${y.fiscal_year}`,
      revenue: y.revenue,
      netIncome: y.net_income,
    }));
}

/** Exact XBRL quarterly figures → chart points; drops quarters with no usable data. */
export function buildQuarterlyPoints(
  quarters: QuarterlyFinancials[],
): TrendPoint[] {
  return quarters
    .filter((q) => q.revenue !== null || q.net_income !== null)
    .map((q) => ({
      label: formatDate(q.period_end),
      revenue: q.revenue,
      netIncome: q.net_income,
    }));
}

/** One fiscal year of the compare-page overlay. Keys are positional rather than
 * ticker-named: Recharts takes its legend and tooltip text from each Line's
 * `name`, so dynamic keys would buy nothing and cost the type. */
export interface CompareTrendRow {
  label: string;
  aRevenue: number | null;
  aNetIncome: number | null;
  bRevenue: number | null;
  bNetIncome: number | null;
}

/** Two companies' annual points onto one shared axis: the union of their fiscal
 * years, ascending. A year missing from one side stays null there, which the
 * chart renders as a gap rather than a straight line through it. */
export function mergeTrendPoints(
  a: TrendPoint[],
  b: TrendPoint[],
): CompareTrendRow[] {
  const byLabel = new Map<string, CompareTrendRow>();

  function row(label: string): CompareTrendRow {
    let existing = byLabel.get(label);
    if (!existing) {
      existing = {
        label,
        aRevenue: null,
        aNetIncome: null,
        bRevenue: null,
        bNetIncome: null,
      };
      byLabel.set(label, existing);
    }
    return existing;
  }

  a.forEach((p) => {
    const r = row(p.label);
    r.aRevenue = p.revenue;
    r.aNetIncome = p.netIncome;
  });
  b.forEach((p) => {
    const r = row(p.label);
    r.bRevenue = p.revenue;
    r.bNetIncome = p.netIncome;
  });

  // Labels are "FY####", so a string sort is chronological.
  return [...byLabel.values()].sort((x, y) => x.label.localeCompare(y.label));
}
