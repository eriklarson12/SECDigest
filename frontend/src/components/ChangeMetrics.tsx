import type { Headline, HeadlineRow } from "@/lib/changes";
import { formatCurrency, formatEps } from "@/lib/format";
import Delta from "./Delta";
import SectionHeader from "./SectionHeader";

function figure(row: HeadlineRow, value: number | null): string {
  if (value === null) return "—";
  return row.format === "eps" ? formatEps(value) : formatCurrency(value);
}

/** Headline figures for both filings' periods (roadmap 12.2), from the financials payload the
 * page already holds. Wrapper scrolls on narrow screens. */
export default function ChangeMetrics({ headline }: { headline: Headline }) {
  if (headline.kind === "missing") {
    return (
      <div>
        <SectionHeader title="Headline figures" />
        <p className="mt-3 text-sm text-muted">
          SEC XBRL company facts have no figures for one of these periods yet.
        </p>
      </div>
    );
  }

  return (
    <div>
      <SectionHeader
        title="Headline figures"
        caption="As reported, SEC XBRL company facts"
      />
      <div className="mt-2 overflow-x-auto">
        <table className="w-full font-sans text-xs">
          <thead>
            <tr className="border-b border-border text-right text-2xs uppercase tracking-[0.06em] text-muted">
              <th className="py-1.5 pr-4 text-left">Metric</th>
              <th className="py-1.5 pl-4">{headline.priorLabel}</th>
              <th className="py-1.5 pl-4">{headline.currentLabel}</th>
              <th className="py-1.5 pl-4">Change</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {headline.rows.map((row) => (
              <tr key={row.label} className="border-b border-border text-right">
                <th scope="row" className="py-2 pr-4 text-left font-normal text-text">
                  {row.label}
                </th>
                <td className="py-2 pl-4 text-muted">{figure(row, row.prior)}</td>
                <td className="py-2 pl-4 text-text">{figure(row, row.current)}</td>
                <td className="py-2 pl-4">
                  {row.changePct === null ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <Delta value={row.changePct} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!headline.annual && (
        <p className="mt-2 font-sans text-2xs text-muted">
          Quarterly figures here cover revenue and net income; EPS and operating
          cash flow appear when two annual reports are compared.
        </p>
      )}
    </div>
  );
}
