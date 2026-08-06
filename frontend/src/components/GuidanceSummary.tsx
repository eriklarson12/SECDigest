import { FileText, TrendingUp } from "lucide-react";

interface GuidanceSummaryProps {
  guidance: string | null;
  summary: string | null;
}

export default function GuidanceSummary({
  guidance,
  summary,
}: GuidanceSummaryProps) {
  return (
    <div className="space-y-4">
      {summary && (
        <div className="rounded-xl border border-border bg-surface p-5">
          <h3 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
            <FileText className="h-4 w-4" strokeWidth={1.5} aria-hidden />
            Executive Summary
          </h3>
          <p className="text-sm leading-relaxed text-text">{summary}</p>
        </div>
      )}
      {guidance && (
        <div className="rounded-xl border border-border bg-surface p-5">
          <h3 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
            <TrendingUp className="h-4 w-4" strokeWidth={1.5} aria-hidden />
            Management Guidance
          </h3>
          <p className="text-sm leading-relaxed text-text">{guidance}</p>
        </div>
      )}
    </div>
  );
}
