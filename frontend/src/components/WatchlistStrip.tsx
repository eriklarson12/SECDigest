"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getWatchlist, subscribeWatchlist } from "@/lib/watchlist";
import { hasNewFiling, loadWatchStatus } from "@/lib/watchlistStatus";
import type { WatchItem } from "@/lib/types";

/** A one-line personal signal above the global recents: how many companies are
 * watched, and how many have filed since they were last analyzed.
 *
 * The count comes straight from localStorage and renders on the first client
 * tick; the newer-filing half needs two requests per company and fills in
 * after. That is the *partial* state from docs/design-system.md — announce it
 * in a `role="status"` region, and on failure show nothing rather than putting
 * an error on a strip whose first half is correct. */
export default function WatchlistStrip() {
  // null = still reading localStorage (first client tick)
  const [items, setItems] = useState<WatchItem[] | null>(null);
  const [newerCount, setNewerCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // localStorage is read after a microtask — no synchronous setState here
      await Promise.resolve();
      if (cancelled) return;
      const watched = getWatchlist();
      setItems(watched);
      if (watched.length === 0) return;

      // Shared cache: /watchlist resolves the same lookups, so navigating
      // there costs nothing further inside the TTL.
      const statuses = await Promise.all(watched.map(loadWatchStatus));
      if (cancelled) return;
      setNewerCount(statuses.filter(hasNewFiling).length);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Unstarring elsewhere changes the count under us
  useEffect(() => {
    return subscribeWatchlist(() => setItems(getWatchlist()));
  }, []);

  if (items === null || items.length === 0) return null;

  return (
    <section
      className="mt-8 border-b border-border pb-1.5"
      aria-label="Watchlist"
    >
      {/* Fixed height: the newer-filing half arrives after the fetches and must
          not push the recents list down (Lighthouse budgets CLS on this page). */}
      <p className="flex h-6 items-baseline gap-1.5 font-sans text-xs text-muted">
        <Link
          href="/watchlist"
          className="text-text transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Watching {items.length}
        </Link>
        <span role="status">
          {newerCount != null && newerCount > 0 && (
            <>
              · {newerCount} {newerCount === 1 ? "has" : "have"} filings newer
              than your analysis
            </>
          )}
        </span>
      </p>
    </section>
  );
}
