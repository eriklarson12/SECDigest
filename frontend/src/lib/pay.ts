import { formatCurrency, formatDate, formatEps } from "./format";
import type { AnnualFinancials, PayVersusPerformance } from "./types";

/** Pay versus performance rows and copy (roadmap 15.1). Pure, so the join and every sentence
 * the table shows are tested. */

export interface PayRow {
  periodEnd: string;
  /** Null when the filer tagged no name; the table shows "CEO". */
  name: string | null;
  totalComp: number | null;
  compActuallyPaid: number | null;
  tsr: number | null;
  peerTsr: number | null;
  measureValue: number | null;
  measureUnit: string | null;
  /** From the 10-K figures, never the proxy: SBUX tags the proxy's in unscaled millions. */
  netIncome: number | null;
}

export const EMPTY_LINE = "No tagged pay-versus-performance table in the latest proxy.";

export const FOOTNOTE =
  "“Actually paid” is the summary total with equity awards marked to fair value, so it can be negative. TSR is the value of $100 invested at the start of the window. Net income is from the 10-K, not the proxy. The company’s own measure is shown as it tagged it.";

/** One row per executive per year, newest year first. A year with two PEOs gives two rows. */
export function payRows(pay: PayVersusPerformance, years: AnnualFinancials[]): PayRow[] {
  const netIncome = new Map<string, number | null>();
  for (const year of years) {
    if (year.period_end) netIncome.set(year.period_end, year.net_income);
  }
  return pay.years.flatMap((year) => {
    const shared = {
      periodEnd: year.period_end,
      tsr: year.tsr,
      peerTsr: year.peer_tsr,
      measureValue: year.measure_value,
      measureUnit: year.measure_unit,
      netIncome: netIncome.get(year.period_end) ?? null,
    };
    if (year.executives.length === 0) {
      return [{ ...shared, name: null, totalComp: null, compActuallyPaid: null }];
    }
    return year.executives.map((exec) => ({
      ...shared,
      name: exec.name,
      totalComp: exec.total_comp,
      compActuallyPaid: exec.comp_actually_paid,
    }));
  });
}

/** The company-selected measure in its tagged unit. A `pure` value is often a per-share figure
 * tagged without its unit (SBUX's Adjusted EPS), so it is shown as a bare number. */
export function formatMeasure(value: number | null, unit: string | null): string {
  if (value === null) return "—";
  if (unit === "USD") return formatCurrency(value);
  if (unit === "USD/share") return formatEps(value);
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function hasPeerTsr(pay: PayVersusPerformance): boolean {
  return pay.years.some((y) => y.peer_tsr !== null);
}

export function hasMeasure(pay: PayVersusPerformance): boolean {
  return pay.years.some((y) => y.measure_value !== null);
}

export function sourceLine(pay: PayVersusPerformance): string {
  const filed = pay.filing_date ? ` filed ${formatDate(pay.filing_date)}` : "";
  return `From the pay-versus-performance table in the latest proxy${filed}.`;
}
