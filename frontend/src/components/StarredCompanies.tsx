"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Star } from "lucide-react";
import { getWatchlist, subscribeWatchlist } from "@/lib/watchlist";
import {
  hasNewFiling,
  loadWatchStatus,
  type WatchStatus,
} from "@/lib/watchlistStatus";
import { formatDate } from "@/lib/format";
import type { WatchItem } from "@/lib/types";
import Delta from "./Delta";
import FormBadge from "./FormBadge";

/** The starred companies themselves, above the global recents — the homepage's
 * only personal content. It replaces the earlier one-line "Watching N" strip:
 * a count names the list without showing it, which is the one thing a reader
 * already knows.
 *
 * The tickers come straight from localStorage and render on the first client
 * tick; each card's filing status needs two requests and fills in after. That
 * is the *partial* state from docs/design-system.md — announce it in a
 * `role="status"` region, and on failure show nothing rather than putting an
 * error on a card whose name and link are correct. */

/** Four fills one row at `sm` and two at mobile. Past that the list is a page,
 * not a section, and the header links to it. */
const SHOWN = 4;

type Card =
  | WatchStatus
  | { item: WatchItem; status: "loading"; latestFiling: null };

export default function StarredCompanies() {
  // null = still reading localStorage (first client tick)
  const [items, setItems] = useState<WatchItem[] | null>(null);
  const [cards, setCards] = useState<Card[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // localStorage is read after a microtask — no synchronous setState here
      await Promise.resolve();
      if (cancelled) return;
      const watched = getWatchlist();
      setItems(watched);

      const shown = watched.slice(0, SHOWN);
      setCards(
        shown.map((item) => ({
          item,
          status: "loading" as const,
          latestFiling: null,
        })),
      );

      // Shared cache: /watchlist resolves the same lookups, so navigating
      // there costs nothing further inside the TTL. Only the shown cards are
      // fetched — a 20-item watchlist would blow the 30/min filings limit.
      shown.forEach(async (item, index) => {
        const status = await loadWatchStatus(item);
        if (cancelled) return;
        setCards((prev) => {
          if (index >= prev.length) return prev;
          const next = [...prev];
          next[index] = status;
          return next;
        });
      });
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Unstarring elsewhere drops a card under us
  useEffect(() => {
    return subscribeWatchlist(() => {
      const watched = getWatchlist();
      setItems(watched);
      const kept = new Set(watched.slice(0, SHOWN).map((i) => i.ticker));
      setCards((prev) => prev.filter((c) => kept.has(c.item.ticker)));
    });
  }, []);

  if (items === null || items.length === 0) return null;

  return (
    <section className="mt-6" aria-label="Starred companies">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="flex items-center gap-1.5 font-sans text-xs font-semibold uppercase tracking-[0.07em] text-text">
          <Star className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
          Starred
        </h2>
        {items.length > SHOWN && (
          <Link
            href="/watchlist"
            className="font-sans text-2xs uppercase tracking-[0.08em] text-muted transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            View all {items.length}
          </Link>
        )}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map((card) => {
          const isNew = card.status !== "loading" && hasNewFiling(card);
          return (
            <div
              key={card.item.ticker}
              className="border border-border bg-surface p-3 transition-colors duration-150 hover:border-primary/50"
            >
              <div className="flex items-baseline justify-between gap-2">
                <Link
                  href={`/company/${card.item.ticker}`}
                  className="font-sans text-sm font-semibold text-text transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  {card.item.ticker}
                </Link>
                {isNew && (
                  <span className="bg-accent/15 px-1.5 py-0.5 font-sans text-3xs font-semibold text-accent">
                    New
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-2xs text-muted">
                {card.item.name}
              </p>
              {/* Fixed height: the status half arrives after two fetches and
                  must not push the recents list down (Lighthouse budgets CLS
                  on this page). */}
              <div className="mt-2 min-h-8" role="status">
                <CardStatus card={card} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Revenue YoY when the company has been analyzed, else what it last filed.
 * The `suffix` is not decoration: SECDigest has no share-price data, and a
 * bare "▲ 12.4%" on a company card is read as one. */
function CardStatus({ card }: { card: Card }) {
  if (card.status === "loading") {
    return <div className="h-4 w-20 bg-surface-2 motion-safe:animate-pulse" />;
  }
  if (card.status === "error") {
    return <p className="text-2xs text-muted">Couldn&apos;t check filings</p>;
  }

  const change = card.latestAnalysis?.revenue_yoy_change_pct;
  if (change != null) {
    return (
      <Delta value={change} suffix="revenue YoY" className="block text-2xs" />
    );
  }
  if (card.latestFiling) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <FormBadge formType={card.latestFiling.form_type} />
        <span className="font-sans text-2xs tabular-nums text-muted">
          {formatDate(card.latestFiling.filing_date)}
        </span>
      </div>
    );
  }
  return <p className="text-2xs text-muted">No recent filings</p>;
}
