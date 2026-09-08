import { formatPercentile, percentileBarWidth } from "@/lib/percentiles";
import { metricLabel } from "@/lib/revisions";
import type { Percentile } from "@/lib/types";

/** Where this company's figures sit among every filer that tagged the same concept for the same
 * XBRL frame period (roadmap 9.4). Absolute, where `/benchmark` alone is relative: it answers
 * whether a 9% net margin is good, not merely how it compares to peers you picked.
 *
 * It may sit above other sections despite arriving with a fetch, for the same reason `Revisions`
 * may: these rows come back in the *same* response as the metrics table they annotate, so they
 * are never a second commit relative to it.
 *
 * The figure is always rendered as text and the bar is `aria-hidden`, so nothing here is carried
 * by width or colour alone. The bar takes `accent`, never `positive`/`negative`: those mean good
 * and bad, and a percentile is a position. */
export default function PercentileRanks({
  percentiles,
}: {
  percentiles: Percentile[];
}) {
  if (percentiles.length === 0) return null;

  const period = percentiles[0].period;

  return (
    <div>
      <div className="flex items-end justify-between gap-3 border-b border-text pb-1.5">
        <h3 className="font-sans text-xs font-semibold uppercase tracking-[0.07em] text-text">
          Rank among filers
        </h3>
        <p className="font-sans text-2xs text-muted">
          SEC XBRL frames, {period}
        </p>
      </div>

      <ul className="mt-3 space-y-5">
        {percentiles.map((entry) => (
          <li key={entry.metric} className="font-sans text-xs">
            {/* Stacked below sm and side by side above it: a nowrap row of label, bar and
                figure overflows 375px (docs/design-system.md). */}
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="text-text">{metricLabel(entry.metric)}</span>
              <span className="tabular-nums text-text">
                {formatPercentile(entry.percentile)}
                <span className="ml-1.5 text-2xs text-muted">
                  of {entry.population.toLocaleString()} filers
                </span>
              </span>
            </div>
            {/* Decoration: every value it encodes is already text above it. */}
            <div aria-hidden className="mt-1.5 h-1.5 w-full bg-surface-2">
              <div
                className="h-full bg-accent"
                style={{ width: `${percentileBarWidth(entry.percentile)}%` }}
              />
            </div>
            {/* A us-gaap tag is one unbroken word up to 61 characters
                ("NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"), which is
                wider than a 375px viewport and has no break opportunity of its own. */}
            <p className="mt-1 break-words text-2xs text-muted">{entry.concept}</p>
          </li>
        ))}
      </ul>

      {/* Both facts are load-bearing and neither is guessable from the bars. The population is
          the filers that tagged this concept, and a frame's calendar year is not a fiscal year:
          a company whose year ends 2026-05-31 is ranked inside CY2025. */}
      <p className="mt-3 font-sans text-2xs leading-relaxed text-muted">
        Ranked against every filer that tagged the same concept for {period}, not
        against all public companies. Frames group filings by approximate calendar
        alignment rather than by fiscal year, so a company whose year ends part
        way through the next one is still counted here.
      </p>
    </div>
  );
}
