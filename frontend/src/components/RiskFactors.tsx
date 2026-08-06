import { ShieldAlert } from "lucide-react";

interface RiskFactorsProps {
  risks: string[];
  /** Parallel to risks — true marks a risk absent from the prior filing. */
  newFlags?: boolean[];
  /** Prior-filing risks no longer highlighted in this one. */
  dropped?: string[];
  /** Describes the comparison baseline, e.g. "10-Q filed Feb 2, 2026". */
  priorLabel?: string;
}

export default function RiskFactors({
  risks,
  newFlags,
  dropped = [],
  priorLabel,
}: RiskFactorsProps) {
  if (!risks.length) return null;

  const hasDrift = newFlags !== undefined && priorLabel !== undefined;

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
        <ShieldAlert className="h-4 w-4" strokeWidth={1.5} aria-hidden />
        Key Risk Factors
      </h3>
      <ol className="space-y-2">
        {risks.map((risk, i) => (
          <li key={i} className="flex gap-3 text-sm leading-relaxed text-text">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-negative/15 font-mono text-xs font-semibold tabular-nums text-negative">
              {i + 1}
            </span>
            <span>
              {risk}
              {hasDrift && newFlags[i] && (
                <span className="ml-2 inline-block rounded bg-accent/15 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-accent">
                  New
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {hasDrift && (
        <p className="mt-4 border-t border-border pt-3 text-xs text-muted">
          Compared with the {priorLabel}.
          {dropped.length === 0 && !newFlags.some(Boolean) && (
            <> No notable changes in highlighted risks.</>
          )}
        </p>
      )}
      {hasDrift && dropped.length > 0 && (
        <div className="mt-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted">
            No Longer Highlighted
          </h4>
          <ul className="mt-1 space-y-1">
            {dropped.map((risk, i) => (
              <li key={i} className="text-xs leading-relaxed text-muted">
                {risk}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
