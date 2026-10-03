import type { Filing } from "@/lib/types";
import EventRow from "./EventRow";

/** A company's recent 8-Ks, read as events rather than as documents (roadmap 9.2).
 *
 * Renders nothing at all when the company has filed none, which is why it sits last on the page:
 * a section whose height is unknown until a fetch lands must have nothing below it to displace
 * (frontend/CLAUDE.md). It costs no request of its own — the rows arrive in the same response as
 * the filing list above it. */
export default function RecentEvents({ events }: { events: Filing[] }) {
  if (events.length === 0) return null;

  return (
    <section aria-label="Recent events">
      <h2 className="mb-3 text-lg font-semibold text-text">Recent Events</h2>
      <p className="mb-3 text-sm text-muted">
        What this company reported to the SEC between its quarterly reports, named
        by the item codes on each filing.
      </p>
      <ol className="space-y-2">
        {events.map((event) => (
          <EventRow key={event.accession_number} event={event} />
        ))}
      </ol>
    </section>
  );
}
