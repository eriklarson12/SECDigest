import { formatDate } from "@/lib/format";
import { eventSummary } from "@/lib/eightk";
import type { Filing } from "@/lib/types";
import FormBadge from "./FormBadge";

/** One 8-K as an event: form, date and what its item codes mean. Shared by the company page's
 * `RecentEvents` and the "what changed" page (roadmap 12.2). */
export default function EventRow({ event }: { event: Filing }) {
  const summary = eventSummary(event.items);
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border border-border bg-surface px-4 py-3">
      <FormBadge formType={event.form_type} />
      <span className="font-sans text-sm tabular-nums text-muted">
        {formatDate(event.filing_date)}
      </span>
      {/* A wrapping line, never chips: `docs/design-system.md` rejects a
          `whitespace-nowrap` pill three times over because it overflows 375px, and
          these labels are longer than the SIC descriptions that produced that rule. */}
      {summary && <span className="min-w-0 text-text">{summary}</span>}
    </li>
  );
}
