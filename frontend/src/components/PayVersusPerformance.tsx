import { ExternalLink, Scale } from "lucide-react";

import { edgarFilingIndexUrl } from "@/lib/edgar";
import { formatCurrency, formatDate, formatEps } from "@/lib/format";
import {
  EMPTY_LINE,
  FOOTNOTE,
  formatMeasure,
  hasMeasure,
  hasPeerTsr,
  payRows,
  sourceLine,
} from "@/lib/pay";
import type { AnnualFinancials, PayVersusPerformance as Pay } from "@/lib/types";
import type { SectionStatus } from "@/lib/useSection";
import ErrorState from "./ErrorState";

interface PayVersusPerformanceProps {
  status: SectionStatus;
  pay: Pay | null;
  error: string | null;
  onRetry: () => void;
  cik: string;
  /** The `/financials` years already on the page: net income comes from these, not the proxy. */
  years: AnnualFinancials[];
}

const LINK_CLASS =
  "inline-flex items-center gap-1.5 font-sans text-2xs text-muted transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

// Table cells use an em dash for gaps, not "N/A"
function money(value: number | null): string {
  return value === null ? "—" : formatCurrency(value);
}

/** CEO pay against shareholder return, from the newest proxy (roadmap 15.1).
 *
 * Last on the company page and nothing while loading, for the `InsiderActivity` reason: the page
 * also holds it back until insiders has settled, so it never lands above a section still to come.
 * Once loaded it always renders: the table, the empty line, or an error. */
export default function PayVersusPerformance({
  status,
  pay,
  error,
  onRetry,
  cik,
  years,
}: PayVersusPerformanceProps) {
  if (status === "loading") return null;

  const rows = pay ? payRows(pay, years) : [];
  const showPeer = pay ? hasPeerTsr(pay) : false;
  const showMeasure = pay ? hasMeasure(pay) : false;

  return (
    <section aria-label="Pay versus performance">
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-text">
        <Scale className="h-4 w-4" strokeWidth={1.5} aria-hidden />
        Pay Versus Performance
      </h2>
      {status === "error" || !pay ? (
        <ErrorState message={error ?? "Failed to load executive pay"} onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">{EMPTY_LINE}</p>
      ) : (
        <>
          <div className="overflow-x-auto print:overflow-visible">
            <table className="w-full font-sans text-xs print:break-inside-avoid">
              <thead>
                <tr className="border-b border-border text-right text-2xs uppercase tracking-[0.06em] text-muted">
                  <th className="py-1.5 pr-4 text-left">Year ended</th>
                  <th className="py-1.5 pr-4 text-left">CEO</th>
                  <th className="py-1.5 pl-4">Total pay</th>
                  <th className="py-1.5 pl-4">Actually paid</th>
                  <th className="py-1.5 pl-4">TSR ($100)</th>
                  {showPeer && <th className="py-1.5 pl-4">Peer TSR</th>}
                  <th className="py-1.5 pl-4">Net income</th>
                  {showMeasure && (
                    <th className="py-1.5 pl-4">{pay.measure_name ?? "Company measure"}</th>
                  )}
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {rows.map((row, i) => (
                  <tr
                    key={`${row.periodEnd}:${row.name ?? ""}:${i}`}
                    className="border-b border-border text-right transition-colors duration-150 hover:bg-surface-2"
                  >
                    <td className="whitespace-nowrap py-1.5 pr-4 text-left text-muted">
                      {formatDate(row.periodEnd)}
                    </td>
                    <td className="py-1.5 pr-4 text-left text-text">{row.name ?? "CEO"}</td>
                    <td className="py-1.5 pl-4 text-text">{money(row.totalComp)}</td>
                    <td className="py-1.5 pl-4 text-text">{money(row.compActuallyPaid)}</td>
                    <td className="py-1.5 pl-4 text-text">{formatEps(row.tsr)}</td>
                    {showPeer && (
                      <td className="py-1.5 pl-4 text-text">{formatEps(row.peerTsr)}</td>
                    )}
                    <td className="py-1.5 pl-4 text-text">{money(row.netIncome)}</td>
                    {showMeasure && (
                      <td className="py-1.5 pl-4 text-text">
                        {formatMeasure(row.measureValue, row.measureUnit)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 font-sans text-2xs text-muted">{FOOTNOTE}</p>
        </>
      )}
      {status === "ready" && pay?.accession_number && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {rows.length > 0 && (
            <p className="font-sans text-2xs text-muted">{sourceLine(pay)}</p>
          )}
          <a
            href={edgarFilingIndexUrl(cik, pay.accession_number)}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK_CLASS}
          >
            <ExternalLink className="h-3 w-3" strokeWidth={1.5} aria-hidden />
            Proxy on SEC.gov
          </a>
        </div>
      )}
    </section>
  );
}
