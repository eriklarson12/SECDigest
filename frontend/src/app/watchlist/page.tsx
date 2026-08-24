"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Star } from "lucide-react";
import { getFilings, listAnalyses } from "@/lib/api";
import { getWatchlist, subscribeWatchlist } from "@/lib/watchlist";
import { hasNewerFiling } from "@/lib/filings";
import { formatDate } from "@/lib/format";
import type { AnalysisResponse, Filing, WatchItem } from "@/lib/types";
import EmptyState from "@/components/EmptyState";
import FormBadge from "@/components/FormBadge";
import WatchStar from "@/components/WatchStar";
import { SkeletonCard } from "@/components/Skeleton";

interface Card {
  item: WatchItem;
  status: "loading" | "error" | "ready";
  latestFiling: Filing | null;
  latestAnalysis: AnalysisResponse | null;
}

/** EDGAR has a filing the stored record hasn't caught up to — worth a visit. */
function hasNewFiling(card: Card): boolean {
  return hasNewerFiling(
    card.latestFiling?.filing_date,
    card.latestAnalysis?.filing_date
  );
}

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
        }))
      );

      // Watchlist is capped at 20 and /api/filings allows 30/min — one
      // parallel batch fits. Failures render per-card, never retried here.
      items.forEach(async (item, index) => {
        const [filings, analyses] = await Promise.allSettled([
          getFilings(item.cik, "10-K,10-Q", 1),
          listAnalyses(1, 0, item.ticker),
        ]);
        if (cancelled) return;
        setCards((prev) => {
          if (!prev) return prev;
          const next = [...prev];
          next[index] = {
            item,
            status: filings.status === "fulfilled" ? "ready" : "error",
            latestFiling:
              filings.status === "fulfilled" ? (filings.value[0] ?? null) : null,
            latestAnalysis:
              analyses.status === "fulfilled"
                ? (analyses.value.analyses[0] ?? null)
                : null,
          };
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
        prev ? prev.filter((c) => kept.has(c.item.ticker)) : prev
      );
    });
  }, []);

  if (cards === null) {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-bold text-text">Watchlist</h1>
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
        <h1 className="mb-6 text-2xl font-bold text-text">Watchlist</h1>
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
      <h1 className="mb-6 text-2xl font-bold text-text">Watchlist</h1>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => {
          const isNew = card.status === "ready" && hasNewFiling(card);
          const href =
            !isNew && card.latestAnalysis
              ? `/analysis/${card.latestAnalysis.id}`
              : "/";
          return (
            <div
              key={card.item.ticker}
              className="relative rounded-xl border border-border bg-surface p-4 transition-colors duration-200 hover:border-primary/50"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/company/${card.item.ticker}`}
                    className="rounded font-mono font-semibold text-text transition-colors duration-200 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    {card.item.ticker}
                  </Link>
                  {isNew && (
                    <span className="rounded bg-accent/15 px-2 py-0.5 font-mono text-xs font-semibold text-accent">
                      New filing
                    </span>
                  )}
                </div>
                <WatchStar item={card.item} />
              </div>
              <p className="mt-1 truncate text-xs text-muted">{card.item.name}</p>
              <div className="mt-3 min-h-6">
                {card.status === "loading" ? (
                  <div className="h-5 w-32 rounded-md bg-surface-2 motion-safe:animate-pulse" />
                ) : card.status === "error" ? (
                  <p className="text-xs text-muted">Couldn&apos;t check filings</p>
                ) : card.latestFiling ? (
                  <div className="flex items-center gap-2">
                    <FormBadge formType={card.latestFiling.form_type} />
                    <span className="font-mono text-xs tabular-nums text-muted">
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
                {!isNew && card.latestAnalysis ? "View analysis" : "Analyze now"}
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}
