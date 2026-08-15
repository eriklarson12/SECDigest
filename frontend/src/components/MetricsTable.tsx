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
    <div className="rounded-xl border border-border bg-surface p-5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
        Annual Metrics
      </h3>
      <p className="mt-1 text-xs text-muted">
        As-reported figures from SEC XBRL company facts
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted">
              <th className="py-2 pr-4">FY</th>
              <th className="py-2 pr-4">Revenue</th>
              <th className="py-2 pr-4">Net Income</th>
              <th className="py-2 pr-4">Diluted EPS</th>
              <th className="py-2 pr-4">Op. Cash Flow</th>
              <th className="py-2 pr-4">Cash</th>
              <th className="py-2 pr-4">Total Assets</th>
              <th className="py-2">Equity</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {years.map((y) => (
              <tr key={y.fiscal_year} className="border-b border-border/50">
                <td className="py-2 pr-4 text-muted">{y.fiscal_year}</td>
                <td className="py-2 pr-4 text-text">{money(y.revenue)}</td>
                <td className="py-2 pr-4 text-text">{money(y.net_income)}</td>
                <td className="py-2 pr-4 text-text">{formatEps(y.eps_diluted ?? null)}</td>
                <td className="py-2 pr-4 text-text">{money(y.operating_cash_flow)}</td>
                <td className="py-2 pr-4 text-text">{money(y.cash)}</td>
                <td className="py-2 pr-4 text-text">{money(y.total_assets)}</td>
                <td className="py-2 text-text">{money(y.stockholders_equity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
