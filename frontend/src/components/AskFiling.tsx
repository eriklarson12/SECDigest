"use client";

import { useEffect, useState } from "react";
import { MessageCircleQuestion, Send } from "lucide-react";
import { ApiError, askFiling, getIndexStatus } from "@/lib/api";
import type { AskResponse, IndexStatus } from "@/lib/types";

/** "Ask this filing" — RAG Q&A answered from the filing's own text, with the
 * retrieved excerpts shown as sources so every claim is verifiable. */

/** Only Risk Factors + MD&A are chunked, so suggestions stay on narrative
 * ground: no cross-filing comparisons (retrieval is scoped to one accession)
 * and no exact figures (those live in tables the index doesn't reach). */
const SUGGESTIONS = [
  "What drove the change in revenue this period?",
  "What does management say about liquidity and capital resources?",
  "Which risks does the company describe as most significant?",
  "What cost pressures does management call out?",
];

/** A full index takes minutes against the free-tier embedding cap, so coverage
 * ramps up after an analysis rather than arriving complete. Polling makes that
 * visible; a filing indexed on an earlier visit answers on the first poll. */
const POLL_MS = 5000;

/** Frame the scale as a property of the filing, not of the answer above it.
 *
 * The model sometimes restates a figure with its scale ("$11,133 million") and
 * sometimes converts outright — Palantir's 931,767 thousand came back as
 * "$932 million". Both are correct, but a bare "In thousands." under the second
 * reads like a contradiction, as if $932 million were somehow $932 thousand.
 * Saying "as filed" pins the declaration to the source figures instead. */
function scaleCaption(scale: string): string {
  return `Source figures as filed: ${scale.charAt(0).toLowerCase()}${scale.slice(1)}`;
}

export default function AskFiling({ analysisId }: { analysisId: number }) {
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [asked, setAsked] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<IndexStatus | null>(null);

  const indexing = coverage?.state === "indexing";

  // Poll until the background index finishes. Chained timeouts rather than an
  // interval so a slow response can't stack requests, and setState only ever
  // happens in the async callback (eslint set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function poll() {
      getIndexStatus(analysisId)
        .then((status) => {
          if (cancelled) return;
          setCoverage(status);
          if (status.state === "indexing") timer = setTimeout(poll, POLL_MS);
        })
        .catch(() => {
          // Coverage is advisory — a failed poll just leaves the notice off
          // rather than putting an error on a card that still works.
        });
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [analysisId]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    ask(question);
  }

  function askSuggestion(suggestion: string) {
    setQuestion(suggestion); // mirror it into the input so the asked text is visible
    ask(suggestion);
  }

  function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;

    setPending(true);
    setError(null);
    setResult(null);
    setAsked(trimmed);

    askFiling(analysisId, trimmed)
      .then((answer) => setResult(answer))
      .catch((e) => {
        // While indexing, a 404 means "not indexed *yet*" — the card's own
        // notice says as much, so don't contradict it with "isn't available".
        if (indexing && e instanceof ApiError && e.status === 404) {
          setError("That part of the filing isn't indexed yet — try again in a moment.");
          return;
        }
        setError(e instanceof Error ? e.message : "Something went wrong — try again.");
      })
      .finally(() => setPending(false));
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
        <MessageCircleQuestion className="h-4 w-4" strokeWidth={1.5} aria-hidden />
        Ask This Filing
      </h3>
      <p className="mb-3 text-sm text-muted">
        Answered only from this filing&apos;s narrative sections — Risk Factors and
        MD&amp;A — with the excerpts used. For exact figures, use the financials
        above.
      </p>

      {coverage?.state === "indexing" && (
        <p role="status" className="mb-3 text-xs text-muted">
          Still indexing the full filing
          {coverage.chunks_total > 0 &&
            ` (${coverage.chunks_indexed} of ${coverage.chunks_total} passages)`}{" "}
          — later sections may not be searchable yet.
        </p>
      )}

      {coverage?.state === "unavailable" && (
        <p role="status" className="mb-3 text-xs text-muted">
          Q&amp;A isn&apos;t available for this filing.
        </p>
      )}

      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="ask-input" className="sr-only">
          Ask a question about this filing
        </label>
        <input
          id="ask-input"
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What does management say about margins?"
          maxLength={300}
          disabled={pending}
          className="h-11 flex-1 rounded-lg border border-border bg-surface-2 px-3 text-sm text-text placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={pending || !question.trim()}
          className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-bg transition-colors duration-200 hover:bg-primary/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Send className="h-4 w-4" strokeWidth={1.5} aria-hidden />
          {pending ? "Asking…" : "Ask"}
        </button>
      </form>

      <div
        role="group"
        aria-label="Suggested questions"
        className="mt-3 flex flex-wrap gap-2"
      >
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => askSuggestion(suggestion)}
            disabled={pending}
            className="min-h-11 cursor-pointer rounded-lg border border-border bg-surface-2 px-3 text-left text-xs leading-snug text-muted transition-colors duration-200 hover:border-primary/40 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <div aria-live="polite">
        {pending && (
          <div className="mt-4 space-y-2">
            <div className="h-4 w-full rounded-md bg-surface-2 motion-safe:animate-pulse" />
            <div className="h-4 w-5/6 rounded-md bg-surface-2 motion-safe:animate-pulse" />
            <div className="h-4 w-2/3 rounded-md bg-surface-2 motion-safe:animate-pulse" />
          </div>
        )}

        {error && !pending && (
          <div className="mt-4">
            <p role="alert" className="text-sm text-negative">
              {error}
            </p>
            <button
              onClick={() => setQuestion(asked)}
              className="mt-2 h-11 cursor-pointer rounded-lg border border-border bg-surface px-5 text-sm font-medium text-text transition-colors duration-200 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Retry
            </button>
          </div>
        )}

        {result && !pending && (
          <div className="mt-4">
            <p className="text-sm leading-relaxed text-text">{result.answer}</p>
            {result.unit_scale && (
              <p className="mt-3 border-t border-border pt-3 text-xs leading-relaxed text-muted">
                {scaleCaption(result.unit_scale)}
              </p>
            )}
            {result.sources.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer rounded text-xs font-medium uppercase tracking-wide text-muted transition-colors duration-200 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                  Sources ({result.sources.length})
                </summary>
                <ol className="mt-2 list-decimal space-y-2 pl-5 text-xs leading-relaxed text-muted">
                  {result.sources.map((source) => (
                    <li key={source.chunk_index}>{source.excerpt}…</li>
                  ))}
                </ol>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
