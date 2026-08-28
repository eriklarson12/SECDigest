import Link from "next/link";
import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  message?: string;
  action?:
    { href: string; label: string } | { label: string; onClick: () => void };
}

const actionClass =
  "mt-4 inline-flex h-11 items-center border border-text px-5 font-sans text-xs tracking-[0.06em] text-text transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

export default function EmptyState({
  icon: Icon,
  title,
  message,
  action,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center py-16 text-center">
      <div className="border border-border bg-surface p-4">
        <Icon className="h-8 w-8 text-muted" strokeWidth={1.5} aria-hidden />
      </div>
      <p className="mt-4 font-semibold text-text">{title}</p>
      {message && <p className="mt-1 max-w-md text-sm text-muted">{message}</p>}
      {action &&
        ("href" in action ? (
          <Link href={action.href} className={actionClass}>
            {action.label}
          </Link>
        ) : (
          <button
            type="button"
            onClick={action.onClick}
            className={`cursor-pointer ${actionClass}`}
          >
            {action.label}
          </button>
        ))}
    </div>
  );
}
