import { Check } from "lucide-react";
import { ANALYSIS_STAGES } from "@/lib/api";
import type { AnalysisStage } from "@/lib/api";

/** Full-page progress state — reserved for the long analyze POST only.
 * GET loads use the content-shaped Skeleton components instead. */

const STAGE_LABELS: Record<AnalysisStage, string> = {
  cache_check: "Checking for a stored analysis",
  fetching_filing: "Fetching the filing from EDGAR",
  extracting: "Extracting insights",
  storing: "Saving the analysis",
};

export default function LoadingState({
  message = "Reading the filing…",
  stage,
}: {
  message?: string;
  /** Current streamed stage. Absent when the backend answered without SSE — the
   * checklist is then omitted rather than frozen on a stage that will never move. */
  stage?: AnalysisStage | null;
}) {
  const reached = stage ? ANALYSIS_STAGES.indexOf(stage) : -1;

  return (
    <div
      className="flex flex-col items-center justify-center py-20"
      role="status"
    >
      <div
        className="h-12 w-12 motion-safe:animate-spin border-4 border-border border-t-primary"
        aria-hidden
      />
      <p className="mt-4 text-text">{message}</p>

      {reached >= 0 && (
        <ol className="mt-5 font-sans text-xs">
          {ANALYSIS_STAGES.map((name, i) => (
            <li
              key={name}
              aria-current={i === reached ? "step" : undefined}
              className={`flex items-center gap-2 py-1 motion-safe:transition-colors motion-safe:duration-150 ${
                i <= reached ? "text-text" : "text-muted"
              }`}
            >
              {/* `positive` is direction status and belongs to Delta alone, so a
                  done mark stays ink. Radius 0 makes the pending marker a square. */}
              <span
                className="flex h-4 w-4 shrink-0 items-center justify-center"
                aria-hidden
              >
                {i < reached ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <span
                    className={`h-1.5 w-1.5 ${
                      i === reached ? "bg-primary" : "bg-border"
                    }`}
                  />
                )}
              </span>
              {STAGE_LABELS[name]}
            </li>
          ))}
        </ol>
      )}

      <p className="mt-4 text-sm text-muted">
        Large filings take 10–60 seconds to analyze
      </p>
    </div>
  );
}
