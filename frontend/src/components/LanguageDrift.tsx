import Link from "next/link";
import { FileDiff } from "lucide-react";

import { driftView } from "@/lib/drift";
import type { DriftResponse } from "@/lib/types";
import SectionHeader from "./SectionHeader";

interface LanguageDriftProps {
  /** Null while unknown or on a failed fetch: the card is a decoration and renders nothing. */
  drift: DriftResponse | null;
  formType: string;
  /** The "what changed" page for this pair (roadmap 12.2); omitted on that page itself. */
  changesHref?: string;
  /** Gives the note states a heading, where the card is a section of its own. */
  titled?: boolean;
}

const LABEL_CLASS =
  "font-sans text-2xs uppercase tracking-[0.06em] text-muted";

const LINK_CLASS =
  "font-sans text-2xs text-muted underline decoration-border underline-offset-2 transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

function ChangesLink({ href }: { href?: string }) {
  if (!href) return null;
  return (
    <p className="mt-3">
      <Link href={href} className={LINK_CLASS}>
        Everything that changed since the prior filing
      </Link>
    </p>
  );
}

/** How much of the filer's own wording carries over from the prior same-form filing
 * (roadmap 12.1).
 *
 * Not self-fetching, unlike `SimilarLanguage`: the page fetches the payload in the same batch
 * as the ticker history, so it lands in the commit that already redraws the risk diff beside
 * it, and may sit mid-page (frontend/CLAUDE.md). The figure is a level, not a change, so it
 * takes no `positive`/`negative` colour. */
export default function LanguageDrift({
  drift,
  formType,
  changesHref,
  titled = false,
}: LanguageDriftProps) {
  if (!drift) return null;
  const view = driftView(drift, formType);
  // No prior means no pair, so there is no changes page to link to.
  const href = drift.state === "no_prior" ? undefined : changesHref;

  if (view.kind === "note") {
    return (
      <div>
        {titled && <SectionHeader icon={FileDiff} title="Language drift" />}
        <p className={`text-sm text-muted ${titled ? "mt-3" : ""}`}>{view.text}</p>
        <ChangesLink href={href} />
      </div>
    );
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
          <ul className="mt-2 space-y-5">
            {view.passages.map((passage, i) => (
              // Stacked below md, side by side above: two 450-character columns would be
              // unreadably narrow at 375px.
              <li key={i} className="grid gap-3 md:grid-cols-2 md:gap-6">
                <div>
                  <p className={LABEL_CLASS}>This filing</p>
                  <blockquote className="mt-1 border-l border-text pl-3 text-sm leading-relaxed text-text">
                    {passage.text}
                  </blockquote>
                </div>
                {passage.prior !== undefined && (
                  <div>
                    <p className={LABEL_CLASS}>
                      Closest in the {view.priorLabel}
                    </p>
                    {passage.prior ? (
                      <blockquote className="mt-1 border-l border-border pl-3 text-sm leading-relaxed text-muted">
                        {passage.prior}
                      </blockquote>
                    ) : (
                      <p className="mt-1 border-l border-border pl-3 text-sm italic text-muted">
                        Nothing close: this wording is new.
                      </p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-4 text-sm text-muted">
          No passage reads as new against the prior filing.
        </p>
      )}
      <ChangesLink href={href} />
    </section>
  );
}
