import { ExternalLink, Users } from "lucide-react";

import { edgarFilingIndexUrl } from "@/lib/edgar";
import { formatDate, formatEps, formatShareCount } from "@/lib/format";
import {
  MAX_INSIDER_ROWS,
  codeLabel,
  emptyLine,
  netLine,
  plannedLine,
  sourceLine,
} from "@/lib/insiders";
import type { InsiderActivity as Activity } from "@/lib/types";
import ErrorState from "./ErrorState";

interface InsiderActivityProps {
  status: "loading" | "error" | "ready";
  activity: Activity | null;
  error: string | null;
  onRetry: () => void;
  cik: string;
}

const LINK_CLASS =
  "inline-flex items-center gap-1.5 font-sans text-2xs text-muted transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

/** Open-market insider trades from the last 90 days of Form 4s (roadmap 12.5).
 *
 * Last on the company page, and nothing at all while loading: its cold request is the page's
 * slowest, and a skeleton here would be pushed down when `RecentEvents` lands above it
 * (frontend/CLAUDE.md). Once loaded it always renders, either trades, the empty line or an error. */
export default function InsiderActivity({
  status,
  activity,
  error,
  onRetry,
  cik,
}: InsiderActivityProps) {
  if (status === "loading") return null;

  const planned = activity ? plannedLine(activity) : null;

  return (
    <section aria-label="Insider activity">
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-text">
        <Users className="h-4 w-4" strokeWidth={1.5} aria-hidden />
        Insider Activity
      </h2>
      {status === "error" || !activity ? (
        <ErrorState message={error ?? "Failed to load insider activity"} onRetry={onRetry} />
      ) : activity.transactions.length === 0 ? (
        <p className="text-sm text-muted">{emptyLine(activity)}</p>
      ) : (
        <>
          <p className="font-sans text-base font-semibold tabular-nums text-text">
            {netLine(activity)}
          </p>
          {planned && <p className="mt-1 text-sm text-muted">{planned}</p>}
          <ul className="mt-3 space-y-2">
            {activity.transactions.slice(0, MAX_INSIDER_ROWS).map((trade, i) => (
              <li
                key={`${trade.accession_number}:${i}`}
                className="border border-border bg-surface px-4 py-3"
              >
                {/* A wrapping line, never a nowrap row: it has to fold at 375px. */}
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="min-w-0 break-words font-semibold text-text">
                    {trade.owner_name}
                  </span>
                  <span className="min-w-0 break-words text-sm text-muted">{trade.role}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-sans text-sm tabular-nums">
                  <span className="text-text">
                    {codeLabel(trade.code)} {formatShareCount(trade.shares)} shares
                    {trade.price !== null && ` at ${formatEps(trade.price)}`}
                  </span>
                  <span className="text-muted">
                    {formatDate(trade.transaction_date ?? trade.filing_date)}
                  </span>
                  {trade.planned && (
                    <span className="border border-border px-1.5 text-2xs text-muted">
                      10b5-1 plan
                    </span>
                  )}
                  <a
                    href={edgarFilingIndexUrl(cik, trade.accession_number)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={LINK_CLASS}
                  >
                    <ExternalLink className="h-3 w-3" strokeWidth={1.5} aria-hidden />
                    Form 4 on SEC.gov
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {status === "ready" && activity && (
        <p className="mt-3 font-sans text-2xs text-muted">{sourceLine(activity)}</p>
      )}
    </section>
  );
}
