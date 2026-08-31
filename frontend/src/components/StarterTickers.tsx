"use client";

import { useEffect, useState } from "react";
import { addRecent, getRecent } from "@/lib/recentSearches";
import type { CompanySearchResult } from "@/lib/types";

/** Names and CIKs are exactly what `/api/companies/search` returns, SEC casing
 * included — a chip must seed the recents list with the same record a typed
 * search would, or the same company reads two ways across the app. Verified
 * against the live endpoint 2026-08-28. */
const STARTERS: CompanySearchResult[] = [
  { cik: "320193", ticker: "AAPL", name: "Apple Inc." },
  { cik: "789019", ticker: "MSFT", name: "MICROSOFT CORP" },
  { cik: "1045810", ticker: "NVDA", name: "NVIDIA CORP" },
  { cik: "1018724", ticker: "AMZN", name: "AMAZON COM INC" },
  { cik: "1652044", ticker: "GOOGL", name: "Alphabet Inc." },
  { cik: "19617", ticker: "JPM", name: "JPMORGAN CHASE & CO" },
];

interface StarterTickersProps {
  onSelect: (company: CompanySearchResult) => void;
}

/** A first visit is an empty search box with nothing to act on. These chips
 * give it a starting point, and retire themselves: selecting one records a
 * recent search, which is the condition that hides them.
 *
 * The gate is `=== true`, not `!== false`: the chips MUST render on the first
 * render, while `hasRecents` is still null. An earlier version hid them until
 * the effect resolved, which cost 0.0997 CLS and failed the budget in CI. The
 * order is what matters, not the delay — `HowItWorks` is created when the body
 * mounts, and a second commit a microtask later then moved a node the browser
 * had already painted. Rendering the chips in that first commit means nothing
 * below them ever moves. Do not re-invert this to defer to localStorage.
 *
 * The cost lands on returning visitors, who see the chips briefly before the
 * effect removes them. That is the better trade: first-time visitors are the
 * ones these chips exist for, and they were the ones paying for it. */
export default function StarterTickers({ onSelect }: StarterTickersProps) {
  // null = still reading localStorage (first client tick)
  const [hasRecents, setHasRecents] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    // localStorage is read after a microtask — no synchronous setState here
    Promise.resolve().then(() => {
      if (!cancelled) setHasRecents(getRecent().length > 0);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (hasRecents === true) return null;

  function handleClick(company: CompanySearchResult) {
    // The two calls SearchBar makes on a listbox selection, in the same order,
    // so a chip and a typed search are indistinguishable downstream.
    addRecent(company);
    onSelect(company);
  }

  return (
    <section className="mt-6" aria-label="Suggested companies">
      <h2 className="font-sans text-xs font-semibold uppercase tracking-[0.07em] text-text">
        Start with
      </h2>
      <div className="mt-2 flex flex-wrap gap-2">
        {STARTERS.map((company) => (
          <button
            key={company.cik}
            type="button"
            onClick={() => handleClick(company)}
            aria-label={`${company.ticker} — ${company.name}`}
            className="h-11 cursor-pointer border border-border px-3 font-sans text-2xs tabular-nums text-text transition-colors duration-150 hover:border-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {company.ticker}
          </button>
        ))}
      </div>
    </section>
  );
}
