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
import EmptyState from "@/components/EmptyState";
import FormBadge from "@/components/FormBadge";
import WatchStar from "@/components/WatchStar";
import { SkeletonCard } from "@/components/Skeleton";

/** A resolved status, or the placeholder shown while its request is in flight.
 * The union (rather than a third status on one shape) is what lets
 * `hasNewFiling` take a `WatchStatus` and narrow here. */
type Card =
  | WatchStatus
  | {
      item: WatchItem;
      status: "loading";
      latestFiling: null;
      latestAnalysis: null;
    };

export default function WatchlistPage() {
  // null = still reading localStorage (first client tick)
  const [cards, setCards] = useState<Card[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // localStorage is read after a microtask — no synchronous setState here
      await Promise.resolve();
      if (cancelled) return;
      const items = getWatchlist();
      setCards(
        items.map((item) => ({
          item,
          status: "loading" as const,
          latestFiling: null,
          latestAnalysis: null,
        })),
      );

      // Two requests per company, cached in lib/watchlistStatus so the
      // homepage strip and this page share one lookup. Failures render
      // per-card, never retried here.
      items.forEach(async (item, index) => {
        const status = await loadWatchStatus(item);
        if (cancelled) return;
        setCards((prev) => {
          if (!prev) return prev;
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

  // Unstarring via a card's WatchStar drops the card immediately
  useEffect(() => {
    return subscribeWatchlist(() => {
      const kept = new Set(getWatchlist().map((i) => i.ticker));
      setCards((prev) =>
        prev ? prev.filter((c) => kept.has(c.item.ticker)) : prev,
      );
    });
  }, []);

  if (cards === null) {
    return (
      <div>
        <h1 className="mb-6 text-2xl text-text">Watchlist</h1>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div>
        <h1 className="mb-6 text-2xl text-text">Watchlist</h1>
        <EmptyState
          icon={Star}
          title="Your watchlist is empty"
          message="Star a company from its filings list or dashboard and it will show up here."
          action={{ href: "/", label: "Search a ticker" }}
        />
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl text-text">Watchlist</h1>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => {
          const isNew = card.status !== "loading" && hasNewFiling(card);
          const href =
            !isNew && card.latestAnalysis
              ? `/analysis/${card.latestAnalysis.id}`
              : "/";
          return (
            <div
              key={card.item.ticker}
              className="relative border border-border bg-surface p-4 transition-colors duration-200 hover:border-primary/50"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/company/${card.item.ticker}`}
                    className="font-sans font-semibold text-text transition-colors duration-200 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    {card.item.ticker}
                  </Link>
                  {isNew && (
                    <span className="bg-accent/15 px-2 py-0.5 font-sans text-xs font-semibold text-accent">
                      New filing
                    </span>
                  )}
                </div>
                <WatchStar item={card.item} />
              </div>
              <p className="mt-1 truncate text-xs text-muted">
                {card.item.name}
              </p>
              <div className="mt-3 min-h-6">
                {card.status === "loading" ? (
                  <div className="h-5 w-32 bg-surface-2 motion-safe:animate-pulse" />
                ) : card.status === "error" ? (
                  <p className="text-xs text-muted">
                    Couldn&apos;t check filings
                  </p>
                ) : card.latestFiling ? (
                  <div className="flex items-center gap-2">
                    <FormBadge formType={card.latestFiling.form_type} />
                    <span className="font-sans text-xs tabular-nums text-muted">
                      {formatDate(card.latestFiling.filing_date)}
                    </span>
                  </div>
                ) : (
                  <p className="text-xs text-muted">No recent filings</p>
                )}
              </div>
              <Link
                href={href}
                className="mt-3 inline-flex items-center text-sm font-medium text-primary transition-colors duration-200 hover:text-primary/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {!isNew && card.latestAnalysis
                  ? "View analysis"
                  : "Analyze now"}
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}
