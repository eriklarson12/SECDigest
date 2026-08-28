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
    <div>
      <h3 className="border-b border-text pb-1.5 font-sans text-[10px] uppercase tracking-[0.1em] text-muted">
        Key risk factors
      </h3>
      <ol>
        {risks.map((risk, i) => (
          <li
            key={i}
            className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2.5 border-b border-border py-2 last:border-b-0"
          >
            <span className="pt-1 font-sans text-[11px] tabular-nums text-muted">
              {i + 1}
            </span>
            <span className="max-w-[64ch] leading-relaxed text-text">
              {risk}
              {hasDrift && newFlags[i] && (
                <span className="ml-1.5 whitespace-nowrap border border-primary px-1 align-middle font-sans text-[9.5px] uppercase tracking-[0.06em] text-primary">
                  New
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {hasDrift && (
        <p className="marginnote mt-3 text-sm">
          Compared with the {priorLabel}.
          {dropped.length === 0 && !newFlags.some(Boolean) && (
            <> No notable changes in highlighted risks.</>
          )}
        </p>
      )}
      {hasDrift && dropped.length > 0 && (
        <div className="mt-2">
          <h4 className="font-sans text-[10px] uppercase tracking-[0.1em] text-muted">
            No longer highlighted
          </h4>
          <ul className="mt-1 space-y-1">
            {dropped.map((risk, i) => (
              <li
                key={i}
                className="max-w-[64ch] text-sm leading-relaxed text-muted"
              >
                {risk}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
