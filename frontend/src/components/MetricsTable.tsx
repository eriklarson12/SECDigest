import { hasAnnualMetrics } from "@/lib/financials";
import { formatCurrency, formatEps } from "@/lib/format";
import type { AnnualFinancials } from "@/lib/types";

// Table cells use an em dash for gaps, not "N/A"
function money(value: number | null | undefined): string {
  return value == null ? "—" : formatCurrency(value);
}

/** Per-fiscal-year metrics from SEC XBRL; renders only when a year has a figure beyond
 * revenue/net income (see `hasAnnualMetrics`). Wrapper scrolls on narrow screens. */
export default function MetricsTable({ years }: { years: AnnualFinancials[] }) {
  if (!hasAnnualMetrics(years)) return null;

  return (
    <div>
      <div className="flex items-end justify-between gap-3 border-b border-text pb-1.5">
        <h3 className="font-sans text-[10px] uppercase tracking-[0.1em] text-muted">
          Annual metrics
        </h3>
        <p className="font-sans text-[11px] text-muted">
          As reported, SEC XBRL company facts
        </p>
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full font-sans text-xs">
          <thead>
            <tr className="border-b border-border text-right text-[10px] uppercase tracking-[0.07em] text-muted">
              <th className="py-1.5 pr-4 text-left">FY</th>
              <th className="py-1.5 pl-4">Revenue</th>
              <th className="py-1.5 pl-4">Net Income</th>
              <th className="py-1.5 pl-4">Diluted EPS</th>
              <th className="py-1.5 pl-4">Op. Cash Flow</th>
              <th className="py-1.5 pl-4">Cash</th>
              <th className="py-1.5 pl-4">Total Assets</th>
              <th className="py-1.5 pl-4">Equity</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {years.map((y) => (
              <tr
                key={y.fiscal_year}
                className="border-b border-border text-right transition-colors duration-150 hover:bg-surface-2"
              >
                <td className="py-1.5 pr-4 text-left text-muted">
                  {y.fiscal_year}
                </td>
                <td className="py-1.5 pl-4 text-text">{money(y.revenue)}</td>
                <td className="py-1.5 pl-4 text-text">{money(y.net_income)}</td>
                <td className="py-1.5 pl-4 text-text">
                  {formatEps(y.eps_diluted ?? null)}
                </td>
                <td className="py-1.5 pl-4 text-text">
                  {money(y.operating_cash_flow)}
                </td>
                <td className="py-1.5 pl-4 text-text">{money(y.cash)}</td>
                <td className="py-1.5 pl-4 text-text">
                  {money(y.total_assets)}
                </td>
                <td className="py-2 text-text">
                  {money(y.stockholders_equity)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
