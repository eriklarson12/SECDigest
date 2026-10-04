import { AlertTriangle, ExternalLink } from "lucide-react";

import { edgarFilingIndexUrl } from "@/lib/edgar";
import { formatDate } from "@/lib/format";
import { flagLabel, type PanelFlag } from "@/lib/redflags";
import SectionHeader from "./SectionHeader";

interface RedFlagsProps {
  flags: PanelFlag[];
  cik: string;
  /** `page` matches the company page's h2 sections; `section` is a dashboard card. */
  heading?: "page" | "section";
}

const LINK_CLASS =
  "inline-flex items-center gap-1.5 font-sans text-2xs text-muted transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

/** The few disclosures that matter more than the rest (roadmap 12.4).
 *
 * Renders nothing when there is no flag, and never says "no red flags": a detector's silence is
 * not evidence of health. No `negative` colour either, since that token means a direction. Every
 * row links to its source filing so the reader can check the claim. */
export default function RedFlags({ flags, cik, heading = "section" }: RedFlagsProps) {
  if (flags.length === 0) return null;

  return (
    <section aria-label="Red flags">
      {heading === "page" ? (
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-text">
          <AlertTriangle className="h-4 w-4" strokeWidth={1.5} aria-hidden />
          Red Flags
        </h2>
      ) : (
        <SectionHeader icon={AlertTriangle} title="Red flags" />
      )}
      <p className={`text-sm text-muted ${heading === "page" ? "mb-3" : "mt-3"}`}>
        Detected automatically from SEC item codes, late-filing notices and the
        filing&apos;s own wording. Check each against its source.
      </p>
      <ul className="mt-3 space-y-2">
        {flags.map((flag) => (
          <li
            key={`${flag.accession}:${flag.kind}`}
            className="border border-border bg-surface px-4 py-3"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="min-w-0 font-semibold text-text">{flagLabel(flag)}</span>
              <span className="font-sans text-sm tabular-nums text-muted">
                {formatDate(flag.date)}
              </span>
              <a
                href={edgarFilingIndexUrl(cik, flag.accession)}
                target="_blank"
                rel="noopener noreferrer"
                className={LINK_CLASS}
              >
                <ExternalLink className="h-3 w-3" strokeWidth={1.5} aria-hidden />
                {flag.formType} on SEC.gov
              </a>
            </div>
            {flag.excerpt && (
              <blockquote className="mt-2 border-l border-border pl-3 text-sm leading-relaxed text-muted">
                {flag.excerpt}
              </blockquote>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
