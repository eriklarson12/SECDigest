"use client";

import { useState } from "react";
import { MessageCircleQuestion, Send } from "lucide-react";
import { askFiling } from "@/lib/api";
import type { AskResponse } from "@/lib/types";

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

export default function AskFiling({ analysisId }: { analysisId: number }) {
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [asked, setAsked] = useState("");
  const [error, setError] = useState<string | null>(null);

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
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Something went wrong — try again.")
      )
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
