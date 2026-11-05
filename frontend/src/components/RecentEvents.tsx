import { isEarningsRelease, summaryByAccession, summaryFor } from "@/lib/earnings";
import type { EarningsSummary as Summary, Filing } from "@/lib/types";
import EarningsSummary from "./EarningsSummary";
import EventRow from "./EventRow";

/** A company's recent 8-Ks, read as events rather than as documents (roadmap 9.2).
 *
 * Renders nothing at all when the company has filed none, which is why only `RedFlags` sits below it:
 * a section whose height is unknown until a fetch lands must have nothing below it to displace
 * (frontend/CLAUDE.md). It costs no request of its own — the rows arrive in the same response as
 * the filing list above it.
 *
 * An earnings release (item 2.02) carries a Summarize control from first paint (roadmap 15.3). The
 * stored summaries arrive separately and only relabel it, so their landing moves nothing below. */
export default function RecentEvents({
  events,
  cik,
  summaries,
}: {
  events: Filing[];
  cik: string;
  summaries: Summary[];
}) {
  if (events.length === 0) return null;
  const stored = summaryByAccession(summaries);

  return (
    <section aria-label="Recent events">
      <h2 className="mb-3 text-lg font-semibold text-text">Recent Events</h2>
      <p className="mb-3 text-sm text-muted">
        What this company reported to the SEC between its quarterly reports, named
        by the item codes on each filing.
      </p>
      <ol className="space-y-2">
        {events.map((event) => (
          <EventRow key={event.accession_number} event={event}>
            {isEarningsRelease(event) && (
              <EarningsSummary
                cik={cik}
                accession={event.accession_number}
                stored={summaryFor(stored, event.accession_number)}
              />
            )}
          </EventRow>
        ))}
      </ol>
    </section>
  );
}
