import { FileDiff } from "lucide-react";

import { driftView } from "@/lib/drift";
import type { DriftResponse } from "@/lib/types";
import SectionHeader from "./SectionHeader";

interface LanguageDriftProps {
  /** Null while unknown or on a failed fetch: the card is a decoration and renders nothing. */
  drift: DriftResponse | null;
  formType: string;
}

/** How much of the filer's own wording carries over from the prior same-form filing
 * (roadmap 12.1).
 *
 * Not self-fetching, unlike `SimilarLanguage`: the page fetches the payload in the same batch
 * as the ticker history, so it lands in the commit that already redraws the risk diff beside
 * it, and may sit mid-page (frontend/CLAUDE.md). The figure is a level, not a change, so it
 * takes no `positive`/`negative` colour. */
export default function LanguageDrift({ drift, formType }: LanguageDriftProps) {
  if (!drift) return null;
  const view = driftView(drift, formType);

  if (view.kind === "note") {
    return <p className="text-sm text-muted">{view.text}</p>;
  }

  return (
    <section aria-label="Language drift">
      <SectionHeader icon={FileDiff} title={`Changed since ${view.priorDate}`} />
      <p className="mt-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="text-4xl tabular-nums leading-none text-text">
          {view.figure}
        </span>
        <span className="text-sm text-muted">
          of passages carried over from the {view.priorLabel}
        </span>
      </p>
      <p className="marginnote mt-3 text-sm">
        Measured on the filing&apos;s own wording, not on the summary above.
        Tables and cover-page boilerplate are left out: their figures change
        every period without the text saying anything new.
      </p>

      {view.passages.length > 0 ? (
        <>
          <h4 className="mt-5 font-sans text-2xs uppercase tracking-[0.08em] text-muted">
            Most changed passages
          </h4>
          <ul className="mt-2 space-y-3">
            {view.passages.map((passage, i) => (
              <li key={i}>
                <blockquote className="border-l border-border pl-3 text-sm leading-relaxed text-text">
                  {passage}
                </blockquote>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-4 text-sm text-muted">
          No passage reads as new against the prior filing.
        </p>
      )}
    </section>
  );
}
