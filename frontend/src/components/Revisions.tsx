import { formatCurrency } from "@/lib/format";
import { edgarFilingIndexUrl } from "@/lib/edgar";
import {
  formatRevisionDelta,
  metricLabel,
  revisionArrow,
} from "@/lib/revisions";
import type { Revision } from "@/lib/types";

const linkClass =
  "underline decoration-border underline-offset-2 transition-colors duration-150 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

/** Fiscal years this company has reported more than once, at materially different values
 * (roadmap 9.3). Collapsed by default: it is a footnote to the table above it, not a headline.
 *
 * It may sit above other sections despite arriving with a fetch, unlike `RecentEvents`: these
 * rows come back in the *same* response as the metrics table they annotate, so they are never a
 * second commit relative to it.
 *
 * The word is "revised". Never "restated", "error", "discrepancy" or "correction" — nothing in
 * the XBRL payload distinguishes an error correction from a reclassification, and getting this
 * wrong turns a data feature into an accusation about a real company. */
export default function Revisions({
  cik,
  revisions,
}: {
  cik: string;
  revisions: Revision[];
}) {
  if (revisions.length === 0) return null;

  return (
    <details>
      <summary className="cursor-pointer font-sans text-xs font-semibold uppercase tracking-[0.07em] text-text transition-colors duration-150 hover:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        Revisions to previously reported figures ({revisions.length})
      </summary>
      <p className="mt-2 font-sans text-2xs leading-relaxed text-muted">
        A figure re-reported at a different value in a later filing. This usually
        follows discontinued operations, the adoption of an accounting standard,
        or rounding; SECDigest does not classify which. Both filings are linked
        so you can read them yourself.
      </p>
      <ul className="mt-3 space-y-3">
        {revisions.map((revision) => (
          <li
            key={`${revision.metric}-${revision.fiscal_year}`}
            className="border-t border-border pt-2 font-sans text-xs"
          >
            {/* A wrapping line, never a nowrap row: at 375px this has to fold rather
                than overflow (docs/design-system.md). */}
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-semibold text-text">
                FY{revision.fiscal_year}
              </span>
              <span className="text-text">{metricLabel(revision.metric)}</span>
              <span className="tabular-nums text-muted">
                {formatCurrency(revision.first_val)} →{" "}
                <span className="text-text">
                  {formatCurrency(revision.latest_val)}
                </span>
              </span>
              {/* Arrow and sign together — direction is never colour alone, and these
                  numerals take no direction colour at all: a revision has a direction
                  but no goodness. */}
              <span className="tabular-nums text-muted">
                {revisionArrow(revision.delta_pct)}{" "}
                {formatRevisionDelta(revision.delta_pct)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-2xs text-muted">
              <a
                href={edgarFilingIndexUrl(cik, revision.first_accn)}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClass}
              >
                First report
              </a>
              <a
                href={edgarFilingIndexUrl(cik, revision.latest_accn)}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClass}
              >
                Latest report
              </a>
              <span>{revision.concept}</span>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
