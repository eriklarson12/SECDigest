import { formatDate } from "@/lib/format";
import { eventSummary } from "@/lib/eightk";
import type { Filing } from "@/lib/types";
import FormBadge from "./FormBadge";

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
        {events.map((event) => {
          const summary = eventSummary(event.items);
          return (
            <li
              key={event.accession_number}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border border-border bg-surface px-4 py-3"
            >
              <FormBadge formType={event.form_type} />
              <span className="font-sans text-sm tabular-nums text-muted">
                {formatDate(event.filing_date)}
              </span>
              {/* A wrapping line, never chips: `docs/design-system.md` rejects a
                  `whitespace-nowrap` pill three times over because it overflows 375px, and
                  these labels are longer than the SIC descriptions that produced that rule. */}
              {summary && (
                <span className="min-w-0 text-text">{summary}</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
