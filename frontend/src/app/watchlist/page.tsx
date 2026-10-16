"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Rss, Star } from "lucide-react";
import { useWatchlist } from "@/lib/useWatchlist";
import { watchlistFeedUrl } from "@/lib/api";
import {
  hasNewFiling,
  loadWatchStatus,
  type WatchStatus,
} from "@/lib/watchlistStatus";
import { formatDate } from "@/lib/format";
import type { WatchItem } from "@/lib/types";
import Button from "@/components/Button";
import EmptyState from "@/components/EmptyState";
import FormBadge from "@/components/FormBadge";
import WatchStar from "@/components/WatchStar";
import { SkeletonWatchCard } from "@/components/Skeleton";
import WatchlistImport from "@/components/WatchlistImport";
import CopyWatchlistLink from "@/components/CopyWatchlistLink";

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

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <SkeletonWatchCard />
      <SkeletonWatchCard />
      <SkeletonWatchCard />
    </div>
  );
}

function WatchlistContent() {
  const router = useRouter();
  const importParam = useSearchParams().get("import");
  const items = useWatchlist();
  const [statuses, setStatuses] = useState<Record<string, WatchStatus>>({});
  const [notice, setNotice] = useState<string | null>(null);

  // Two requests per company, cached in lib/watchlistStatus so the homepage
  // strip and this page share one lookup. Failures render per-card, never
  // retried here.
  useEffect(() => {
    if (!items) return;
    let cancelled = false;
    items.forEach(async (item) => {
      const status = await loadWatchStatus(item);
      if (!cancelled)
        setStatuses((prev) => ({ ...prev, [item.ticker]: status }));
    });
    return () => {
      cancelled = true;
    };
  }, [items]);

  // A card keeps its status across a list change, so it doesn't flash back to loading.
  const cards: Card[] | null =
    items?.map(
      (item) =>
        statuses[item.ticker] ?? {
          item,
          status: "loading",
          latestFiling: null,
          latestAnalysis: null,
        },
    ) ?? null;

  function closeImport(message: string | null) {
    if (message) setNotice(message);
    router.replace("/watchlist", { scroll: false });
  }

  let body;
  if (cards === null) {
    body = <SkeletonGrid />;
  } else if (cards.length === 0) {
    body = (
      <EmptyState
        icon={Star}
        title="Your watchlist is empty"
        message="Star a company from its filings list or dashboard and it will show up here."
        action={{ href: "/", label: "Search a ticker" }}
      />
    );
  } else {
    body = (
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
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl text-text">Watchlist</h1>
        {cards !== null && cards.length > 0 && (
          <div className="flex flex-wrap items-start gap-2 print:hidden">
            <Button
              href={watchlistFeedUrl(cards.map((card) => card.item.ticker))}
              icon={Rss}
            >
              Subscribe
            </Button>
            <CopyWatchlistLink />
          </div>
        )}
      </div>
      {importParam !== null ? (
        <WatchlistImport raw={importParam} onClose={closeImport} />
      ) : (
        notice && (
          <div
            role="status"
            className="mb-6 flex items-center justify-between gap-3 border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-text"
          >
            <p>{notice}</p>
            <Button variant="secondary" onClick={() => setNotice(null)}>
              Dismiss
            </Button>
          </div>
        )
      )}
      {body}
    </div>
  );
}

// useSearchParams requires a Suspense boundary in the App Router
export default function WatchlistPage() {
  return (
    <Suspense
      fallback={
        <div>
          <h1 className="mb-6 text-2xl text-text">Watchlist</h1>
          <SkeletonGrid />
        </div>
      }
    >
      <WatchlistContent />
    </Suspense>
  );
}
