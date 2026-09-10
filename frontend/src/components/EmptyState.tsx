import type { LucideIcon } from "lucide-react";
import Button from "./Button";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  message?: string;
  action?:
    { href: string; label: string } | { label: string; onClick: () => void };
}

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
      {action && (
        <div className="mt-4">
          {"href" in action ? (
            <Button href={action.href}>{action.label}</Button>
          ) : (
            <Button onClick={action.onClick}>{action.label}</Button>
          )}
        </div>
      )}
    </div>
  );
}
