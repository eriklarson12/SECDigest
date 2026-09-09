import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** The section-header typography: ink, small caps, sans (docs/design-system.md).
 * Exported for the headings that are not full sections — `Revisions`' `<summary>`
 * and the unruled strip labels — so the treatment still has one home. */
export const SECTION_HEADER_CLASS =
  "font-sans text-xs font-semibold uppercase tracking-[0.07em] text-text";

/** The rule belongs to the heading, never to the section wrapper. */
const SECTION_HEADER_RULE = "border-b border-text pb-1.5";

const NOTE_CLASS = "font-sans text-2xs text-muted";

/** Every underlined section header renders through here, so a new component cannot
 * start a second idiom by copying whichever neighbour it was pasted next to
 * (tasks/lessons.md, 2026-09-08). */
export default function SectionHeader({
  title,
  as: Heading = "h3",
  icon: Icon,
  caption,
  subtitle,
  action,
}: {
  title: ReactNode;
  as?: "h2" | "h3";
  icon?: LucideIcon;
  /** A short provenance note, set opposite the heading on its own baseline. */
  caption?: ReactNode;
  /** The same note under the heading instead — for text too long to sit beside it,
   * or when a control holds the opposite side. */
  subtitle?: ReactNode;
  /** A control sharing the header's row, such as a period toggle. Takes the same
   * side as `caption`; a call site passes one or the other. */
  action?: ReactNode;
}) {
  const bare =
    caption === undefined && subtitle === undefined && action === undefined;

  const heading = (
    <Heading
      className={[
        SECTION_HEADER_CLASS,
        Icon && "flex items-center gap-2",
        // With nothing beside it the heading is the row, so it carries the rule.
        bare && SECTION_HEADER_RULE,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {Icon && <Icon className="h-4 w-4" strokeWidth={1.5} aria-hidden />}
      {title}
    </Heading>
  );

  if (bare) return heading;

  return (
    <div
      className={`flex items-end justify-between gap-3 ${SECTION_HEADER_RULE}`}
    >
      <div>
        {heading}
        {subtitle && <p className={`mt-0.5 ${NOTE_CLASS}`}>{subtitle}</p>}
      </div>
      {action ?? (caption && <p className={NOTE_CLASS}>{caption}</p>)}
    </div>
  );
}
