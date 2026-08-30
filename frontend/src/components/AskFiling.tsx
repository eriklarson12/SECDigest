"use client";

import { useEffect, useState } from "react";
import { MessageCircleQuestion, Send } from "lucide-react";
import { ApiError, askFiling, getIndexStatus, reindexFiling } from "@/lib/api";
import type { AskResponse, IndexStatus } from "@/lib/types";

/** "Ask this filing" — RAG Q&A answered from the filing's own text, with the
 * retrieved excerpts shown as sources so every claim is verifiable. */

/** Only Risk Factors + MD&A are chunked, so suggestions avoid cross-filing comparisons
 * and exact figures — those live in tables the index doesn't reach. */
const SUGGESTIONS = [
  "What drove the change in revenue this period?",
  "What does management say about liquidity and capital resources?",
  "Which risks does the company describe as most significant?",
  "What cost pressures does management call out?",
];

/** Full indexing takes minutes against the free-tier embedding cap, so coverage ramps
 * up after an analysis; polling surfaces that (an earlier-indexed filing answers on the first poll). */
const POLL_MS = 5000;

/** Frames the scale as a filing fact, not the answer's: the model sometimes converts
 * figures (e.g. 931,767 thousand → "$932 million"), so a bare "In thousands." would contradict it. */
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
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  // Bumped to restart polling after a re-index, which the mount-only effect wouldn't see.
  const [pollNonce, setPollNonce] = useState(0);

  const indexing = coverage?.state === "indexing";
  const short = coverage?.state === "partial" || coverage?.state === "unavailable";

  // Chained timeouts (not an interval) so a slow response can't stack requests; setState
  // only happens in the async callback (eslint set-state-in-effect).
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
  }, [analysisId, pollNonce]);

  function repair() {
    if (repairing) return;
    setRepairing(true);
    setRepairError(null);

    reindexFiling(analysisId)
      .then((status) => {
        setCoverage(status);
        setRepairing(false);
        // Resume polling so the card fills in live rather than waiting for a reload.
        if (status.state === "indexing") setPollNonce((n) => n + 1);
      })
      .catch((e) => {
        setRepairError(
          e instanceof Error ? e.message : "Couldn't start indexing.",
        );
        setRepairing(false);
      });
  }

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
          setError(
            "That part of the filing isn't indexed yet — try again in a moment.",
          );
          return;
        }
        setError(
          e instanceof Error ? e.message : "Something went wrong — try again.",
        );
      })
      .finally(() => setPending(false));
  }

  return (
    <div className="border-t border-text pt-4">
      <h3 className="mb-2 flex items-center gap-2 font-sans text-xs font-semibold uppercase tracking-[0.07em] text-text">
        <MessageCircleQuestion
          className="h-4 w-4"
          strokeWidth={1.5}
          aria-hidden
        />
        Ask This Filing
      </h3>
      <p className="mb-3 text-sm text-muted">
        Answered only from this filing&apos;s narrative sections — Risk Factors
        and MD&amp;A — with the excerpts used. For exact figures, use the
        financials above.
      </p>

      {coverage?.state === "indexing" && (
        <p role="status" className="mb-3 text-xs text-muted">
          Still indexing the full filing
          {coverage.chunks_total > 0 &&
            ` (${coverage.chunks_indexed} of ${coverage.chunks_total} passages)`}{" "}
          — later sections may not be searchable yet.
        </p>
      )}

      {short && (
        <div className="mb-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p role="status" className="text-xs text-muted">
              {coverage?.state === "partial"
                ? `Indexed ${coverage.chunks_indexed} of ${coverage.chunks_total} passages — answers may miss later sections.`
                : "Q&A isn't available for this filing."}
            </p>
            <button
              type="button"
              onClick={repair}
              disabled={repairing}
              className="inline-flex min-h-11 cursor-pointer items-center border border-border px-3 font-sans text-3xs uppercase tracking-[0.06em] text-muted transition-colors duration-150 hover:border-text hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              {repairing
                ? "Starting…"
                : coverage?.state === "partial"
                  ? "Index the rest"
                  : "Index this filing"}
            </button>
          </div>
          {repairError && (
            <p role="status" className="mt-1 text-xs text-muted">
              {repairError}
            </p>
          )}
        </div>
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
          className="h-11 flex-1 border-b border-text bg-transparent px-1 text-text placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={pending || !question.trim()}
          className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 border border-text px-5 font-sans text-xs tracking-[0.06em] text-text transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40"
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
          <div className="mt-4">
            <p role="alert" className="text-sm text-negative">
              {error}
            </p>
            <button
              onClick={() => setQuestion(asked)}
              className="mt-2 h-11 cursor-pointer border border-text px-5 font-sans text-xs tracking-[0.06em] text-text transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
                <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted transition-colors duration-200 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
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
