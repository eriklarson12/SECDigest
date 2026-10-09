"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Layers, Send } from "lucide-react";
import { askCompany, getAskScope } from "@/lib/api";
import { splitCitations } from "@/lib/citations";
import { formatDate } from "@/lib/format";
import type {
  AskScopeFiling,
  AskScopeResponse,
  CompanyAskResponse,
  CompanyAskSource,
} from "@/lib/types";
import Button from "./Button";
import ErrorState from "./ErrorState";

/** "Ask across filings" (roadmap 13.2): one question over the company's latest analyzed and
 * indexed filings, each citation linking to the analysis of the filing it came from. */

const SUGGESTIONS = [
  "How have the risk factors changed between these filings?",
  "How has management's description of liquidity changed?",
  "What new competitive pressures appear in the latest filing?",
];

function filingLabel(filing: {
  form_type: string;
  filing_date: string | null;
}) {
  return filing.filing_date
    ? `${filing.form_type} filed ${formatDate(filing.filing_date)}`
    : filing.form_type;
}

/** Sources grouped by filing, in the order each filing first appears in the excerpts. */
function byFiling(sources: CompanyAskSource[]) {
  const groups = new Map<
    number,
    {
      source: CompanyAskSource;
      items: { source: CompanyAskSource; n: number }[];
    }
  >();
  sources.forEach((source, i) => {
    const group = groups.get(source.analysis_id) ?? { source, items: [] };
    group.items.push({ source, n: i + 1 });
    groups.set(source.analysis_id, group);
  });
  return [...groups.values()];
}

const LINK_CLASS =
  "text-text underline decoration-border underline-offset-2 transition-colors duration-150 hover:decoration-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

function Heading() {
  return (
    <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-text">
      <Layers className="h-4 w-4" strokeWidth={1.5} aria-hidden />
      Ask Across Filings
    </h2>
  );
}

/** The page's single-filing case: the per-filing ask lives on that filing's analysis. */
function SingleFiling({ filing }: { filing: AskScopeFiling }) {
  return (
    <section aria-label="Ask across filings">
      <Heading />
      <p className="text-sm text-muted">
        Asking across filings needs two analyzed filings. Until there is a
        second,{" "}
        <Link href={`/analysis/${filing.analysis_id}`} className={LINK_CLASS}>
          ask the {filingLabel(filing)}
        </Link>{" "}
        directly.
      </p>
    </section>
  );
}

function Answer({ result }: { result: CompanyAskResponse }) {
  const segments = splitCitations(result.answer, result.sources.length);
  return (
    <div className="mt-4">
      <p className="text-sm leading-relaxed text-text">
        {segments.map((segment, i) => {
          if (segment.kind === "text") return segment.text;
          const source = result.sources[segment.source];
          return (
            <Link
              key={i}
              href={`/analysis/${source.analysis_id}`}
              aria-label={`Excerpt ${segment.source + 1}, from the ${filingLabel(source)}`}
              className={`font-sans tabular-nums ${LINK_CLASS}`}
            >
              {segment.text}
            </Link>
          );
        })}
      </p>
      {result.sources.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted transition-colors duration-150 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            Sources ({result.sources.length})
          </summary>
          <div className="mt-2 space-y-3">
            {byFiling(result.sources).map(({ source, items }) => (
              <div key={source.analysis_id}>
                <Link
                  href={`/analysis/${source.analysis_id}`}
                  className={`font-sans text-xs ${LINK_CLASS}`}
                >
                  {filingLabel(source)}
                </Link>
                {source.unit_scale && (
                  <p className="text-xs text-muted">
                    Figures as filed: {source.unit_scale}
                  </p>
                )}
                <ol className="mt-1 space-y-2 text-xs leading-relaxed text-muted">
                  {items.map(({ source: item, n }) => (
                    <li key={n}>
                      <span className="font-sans tabular-nums">{n}.</span>{" "}
                      {item.excerpt}…
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export default function AskCompany({ cik }: { cik: string }) {
  const [scope, setScope] = useState<AskScopeResponse | null>(null);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<CompanyAskResponse | null>(null);
  const [asked, setAsked] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // A failed scope renders nothing: the panel is an offer, and an error box for a
    // feature the company may not qualify for would be noise above Insider Activity.
    getAskScope(cik)
      .then((s) => live && setScope(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [cik]);

  if (!scope || scope.filings.length === 0) return null;
  if (!scope.eligible) return <SingleFiling filing={scope.filings[0]} />;

  function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    setResult(null);
    setAsked(trimmed);
    askCompany(cik, trimmed)
      .then(setResult)
      .catch((e) =>
        setError(
          e instanceof Error ? e.message : "Something went wrong — try again.",
        ),
      )
      .finally(() => setPending(false));
  }

  return (
    <section aria-label="Ask across filings">
      <Heading />
      <p className="mb-3 text-sm text-muted">
        Answered from the narrative sections of {scope.filings.length} analyzed
        filings, each claim tied to the filing it came from:{" "}
        <span className="font-sans tabular-nums">
          {scope.filings.map(filingLabel).join(" · ")}
        </span>
        .
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <label htmlFor="ask-company-input" className="sr-only">
          Ask a question across this company&apos;s filings
        </label>
        <input
          id="ask-company-input"
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="How has China risk changed since last year?"
          maxLength={300}
          disabled={pending}
          className="h-11 flex-1 border-b border-text bg-transparent px-1 text-text placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
        />
        <Button
          type="submit"
          icon={Send}
          disabled={pending || !question.trim()}
        >
          {pending ? "Asking…" : "Ask"}
        </Button>
      </form>

      <div
        role="group"
        aria-label="Suggested questions across filings"
        className="mt-3 flex flex-wrap gap-2"
      >
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => {
              setQuestion(suggestion);
              ask(suggestion);
            }}
            disabled={pending}
            className="min-h-11 cursor-pointer border border-border px-3 text-left text-sm leading-snug text-muted transition-colors duration-150 hover:border-text hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <div aria-live="polite">
        {pending && (
          <div className="mt-4 space-y-2">
            <div className="h-4 w-full bg-surface-2 motion-safe:animate-pulse" />
            <div className="h-4 w-5/6 bg-surface-2 motion-safe:animate-pulse" />
            <div className="h-4 w-2/3 bg-surface-2 motion-safe:animate-pulse" />
          </div>
        )}
        {error && !pending && (
          <ErrorState
            message={error}
            inset="inline"
            onRetry={() => setQuestion(asked)}
          />
        )}
        {result && !pending && <Answer result={result} />}
      </div>
    </section>
  );
}
