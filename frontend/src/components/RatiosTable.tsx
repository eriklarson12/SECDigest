import { formatCurrency, formatMultiple, formatPercent } from "@/lib/format";
import {
  currentRatio,
  fcfMargin,
  freeCashFlow,
  grossMargin,
  liabilitiesToEquity,
  operatingMargin,
} from "@/lib/ratios";
import type { AnnualFinancials } from "@/lib/types";
import SectionHeader from "./SectionHeader";

// Table cells use an em dash for gaps, never 0 and never "N/A" (roadmap 12.6)
function cell(value: number | null, format: (v: number) => string): string {
  return value == null ? "—" : format(value);
}

/** Per-year ratios derived from the XBRL annual series (roadmap 12.6). Renders nothing when no
 * year yields a ratio, so a filer without the inputs gets no empty card. */
export default function RatiosTable({ years }: { years: AnnualFinancials[] }) {
  const rows = years.map((y) => ({
    fiscalYear: y.fiscal_year,
    fcf: freeCashFlow(y),
    fcfMargin: fcfMargin(y),
    grossMargin: grossMargin(y),
    operatingMargin: operatingMargin(y),
    leverage: liabilitiesToEquity(y),
    currentRatio: currentRatio(y),
  }));
  const hasAny = rows.some(
    (r) =>
      r.fcf != null ||
      r.grossMargin != null ||
      r.operatingMargin != null ||
      r.leverage != null ||
      r.currentRatio != null,
  );
  if (!hasAny) return null;

  return (
    <div>
      <SectionHeader
        title="Annual ratios"
        caption="Computed from SEC XBRL company facts"
      />
      <div className="mt-2 overflow-x-auto">
        <table className="w-full font-sans text-xs">
          <thead>
            <tr className="border-b border-border text-right text-2xs uppercase tracking-[0.06em] text-muted">
              <th className="py-1.5 pr-4 text-left">FY</th>
              <th className="py-1.5 pl-4">Free Cash Flow</th>
              <th className="py-1.5 pl-4">FCF Margin</th>
              <th className="py-1.5 pl-4">Gross Margin</th>
              <th className="py-1.5 pl-4">Op. Margin</th>
              <th className="py-1.5 pl-4">Liabilities / Equity</th>
              <th className="py-1.5 pl-4">Current Ratio</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => (
              <tr
                key={r.fiscalYear}
                className="border-b border-border text-right transition-colors duration-150 hover:bg-surface-2"
              >
                <td className="py-1.5 pr-4 text-left text-muted">
                  {r.fiscalYear}
                </td>
                <td className="py-1.5 pl-4 text-text">
                  {cell(r.fcf, formatCurrency)}
                </td>
                <td className="py-1.5 pl-4 text-text">
                  {cell(r.fcfMargin, formatPercent)}
                </td>
                <td className="py-1.5 pl-4 text-text">
                  {cell(r.grossMargin, formatPercent)}
                </td>
                <td className="py-1.5 pl-4 text-text">
                  {cell(r.operatingMargin, formatPercent)}
                </td>
                <td className="py-1.5 pl-4 text-text">
                  {cell(r.leverage, formatMultiple)}
                </td>
                <td className="py-1.5 pl-4 text-text">
                  {cell(r.currentRatio, formatMultiple)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 font-sans text-2xs text-muted">
        Free cash flow is operating cash flow less capex. Leverage is total
        liabilities over equity, not debt over equity; where a filer tags no
        total liabilities, it is total liabilities and equity minus equity. A
        dash means the filer does not report that figure.
      </p>
    </div>
  );
}
