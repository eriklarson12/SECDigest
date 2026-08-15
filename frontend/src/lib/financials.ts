/** Shared XBRL → chart-point transforms (AnalysisDashboard + the company page). */

import { formatDate } from "./format";
import type { AnnualFinancials, QuarterlyFinancials, TrendPoint } from "./types";

/** True when a year has data beyond revenue/net income (the chart's job) — per-share,
 * cash-flow, or balance-sheet figures. Shared so the table and its two call sites agree. */
export function hasAnnualMetrics(years: AnnualFinancials[]): boolean {
  return years.some(
    (y) =>
      y.eps_diluted != null ||
      y.operating_cash_flow != null ||
      y.cash != null ||
      y.total_assets != null ||
      y.stockholders_equity != null
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
export function buildQuarterlyPoints(quarters: QuarterlyFinancials[]): TrendPoint[] {
  return quarters
    .filter((q) => q.revenue !== null || q.net_income !== null)
    .map((q) => ({
      label: formatDate(q.period_end),
      revenue: q.revenue,
      netIncome: q.net_income,
    }));
}
