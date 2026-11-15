import { AlertTriangle, ExternalLink } from "lucide-react";

import { edgarFilingIndexUrl } from "@/lib/edgar";
import { formatDate } from "@/lib/format";
import { flagLabel, type PanelFlag } from "@/lib/redflags";
import SectionHeader from "./SectionHeader";

interface RedFlagsProps {
  flags: PanelFlag[];
  cik: string;
  /** `page` is an h2 among the company page's sections; `section` is an h3 dashboard card. */
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
        <SectionHeader as="h2" icon={AlertTriangle} title="Red Flags" />
      ) : (
        <SectionHeader icon={AlertTriangle} title="Red flags" />
      )}
      <p className="mt-3 text-sm text-muted">
        Detected automatically from SEC item codes, late-filing notices and the
        filing&apos;s own wording. Check each against its source.
      </p>
      <ul className="mt-3 space-y-2">
        {flags.map((flag) => (
          <li
            key={`${flag.accession}:${flag.kind}`}
            className="border border-border bg-surface px-4 py-3 print:break-inside-avoid"
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
