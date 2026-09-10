import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Every labelled control renders through here, so a new one cannot add another
 * spelling by copying whichever neighbour it was pasted next to
 * (tasks/lessons.md, 2026-09-08).
 *
 * Two shapes stay out on purpose, because neither is a copy of anything: the
 * icon-square targets (`WatchStar`, the benchmark row's remove) carry no label
 * and size to `h-11 w-11`, and the small bordered chips (`StarterTickers`,
 * `AskFiling`'s suggestions and its index-repair control) differ from each other
 * in type size, alignment and colour rather than repeating one string. */

const BASE =
  "inline-flex h-11 cursor-pointer items-center justify-center gap-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40";

/** Horizontal padding tracks the type size, which is the rule the drifted
 * spellings were already following before three of them reached `px-5` at
 * `text-xs`. */
const VARIANTS = {
  /** The affirmative action — Analyze, Ask, Export CSV, Compare to peers. */
  primary:
    "border border-text px-4 font-sans text-xs tracking-[0.06em] text-text hover:bg-surface-2",
  /** Resuming rather than starting — Retry, Load more. */
  secondary:
    "border border-border bg-surface px-5 text-sm font-medium text-text hover:bg-surface-2",
} as const;

/** There is deliberately no `className`: spacing around a control belongs to the
 * layout that places it, so a caller needing a margin wraps rather than appends.
 * An appended class is how the five spellings above grew in the first place. */
export default function Button({
  children,
  variant = "primary",
  icon: Icon,
  href,
  onClick,
  type = "button",
  disabled = false,
  describedBy,
}: {
  children: ReactNode;
  variant?: keyof typeof VARIANTS;
  /** Set before the label at `h-4 w-4`, the size every other icon in the app uses. */
  icon?: LucideIcon;
  /** Renders a `<Link>` rather than a `<button>`. A disabled link cannot exist,
   * so a control with both states passes `href` only while it is enabled. */
  href?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  /** Points at the copy explaining why the control is disabled. */
  describedBy?: string;
}) {
  const className = `${BASE} ${VARIANTS[variant]}`;
  const content = (
    <>
      {Icon && <Icon className="h-4 w-4" strokeWidth={1.5} aria-hidden />}
      {children}
    </>
  );

  if (href !== undefined) {
    return (
      <Link href={href} className={className}>
        {content}
      </Link>
    );
  }

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-describedby={describedBy}
      className={className}
    >
      {content}
    </button>
  );
}
