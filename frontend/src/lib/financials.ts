/** Shared XBRL → chart-point transforms (AnalysisDashboard + the company page). */

import { formatDate } from "./format";
import type { AnnualFinancials, QuarterlyFinancials, TrendPoint } from "./types";

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
