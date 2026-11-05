"use client";

import { useState } from "react";
import { ExternalLink, FileText } from "lucide-react";
import { summarizeEarnings } from "@/lib/api";
import { FOOTNOTE, buttonLabel } from "@/lib/earnings";
import { edgarDocumentUrl } from "@/lib/edgar";
import type { EarningsSummary as Summary } from "@/lib/types";
import Button from "./Button";

const LINK_CLASS =
  "inline-flex items-center gap-1.5 font-sans text-2xs text-muted transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

/** The Summarize control on one 2.02 event, and the summary it opens (roadmap 15.3).
 *
 * Generated only on a click, never on load: it spends a unit of the daily analysis budget. A stored
 * summary arrives through `stored` and changes only the button's label, so the GET that carries it
 * can land after first paint without moving anything below. The panel opens on a click only. */
export default function EarningsSummary({
  cik,
  accession,
  stored,
}: {
  cik: string;
  accession: string;
  stored: Summary | null;
}) {
  const [result, setResult] = useState<Summary | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = result ?? stored;

  function toggle() {
    if (pending) return;
    if (summary) {
      setOpen((o) => !o);
      return;
    }
    setPending(true);
    setError(null);
    summarizeEarnings(cik, accession)
      .then((s) => {
        setResult(s);
        setOpen(true);
        setPending(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Couldn't summarize this release.");
        setPending(false);
      });
  }

  return (
    <div className="basis-full">
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button icon={FileText} onClick={toggle} disabled={pending}>
          {buttonLabel({ pending, open, hasSummary: summary !== null })}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-muted">
            {error}
          </p>
        )}
      </div>
      {open && summary && (
        <div
          role="region"
          aria-label="Earnings release summary"
          className="mt-3 border-t border-border pt-3"
        >
          <p className="text-sm text-text">{summary.summary}</p>
          {summary.figures.length > 0 && (
            <dl className="mt-3 space-y-3">
              {summary.figures.map((f, i) => (
                <div key={`${f.label}:${i}`}>
                  <dt className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
                    <span>
                      {f.label} · {f.period}
                    </span>
                    {f.is_guidance && (
                      <span className="border border-muted px-1.5 py-0.5 font-sans text-2xs tracking-[0.06em]">
                        Guidance
                      </span>
                    )}
                  </dt>
                  <dd className="font-sans text-sm tabular-nums text-text">{f.value}</dd>
                  <dd>
                    <blockquote className="mt-0.5 border-l border-border pl-2 text-2xs text-muted">
                      “{f.quote}”
                    </blockquote>
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="font-sans text-2xs text-muted">{FOOTNOTE}</p>
            <a
              href={edgarDocumentUrl(cik, summary.accession_number, summary.document)}
              target="_blank"
              rel="noopener noreferrer"
              className={LINK_CLASS}
            >
              <ExternalLink className="h-3 w-3" strokeWidth={1.5} aria-hidden />
              Release on SEC.gov
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
