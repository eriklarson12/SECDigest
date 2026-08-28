"use client";

import { useSyncExternalStore } from "react";
import { Star } from "lucide-react";
import { isWatched, subscribeWatchlist, toggleWatch } from "@/lib/watchlist";
import type { WatchItem } from "@/lib/types";

/** Watchlist star toggle — reads localStorage via useSyncExternalStore so
 * SSR renders unstarred and every star on the page stays in sync. */
export default function WatchStar({ item }: { item: WatchItem }) {
  const watched = useSyncExternalStore(
    subscribeWatchlist,
    () => isWatched(item.ticker),
    () => false,
  );

  return (
    <button
      onClick={() => toggleWatch(item)}
      aria-pressed={watched}
      aria-label={
        watched
          ? `Remove ${item.ticker} from watchlist`
          : `Add ${item.ticker} to watchlist`
      }
      title={watched ? "Remove from watchlist" : "Add to watchlist"}
      className="flex h-11 w-11 cursor-pointer items-center justify-center transition-colors duration-200 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <Star
        className={`h-5 w-5 ${watched ? "fill-accent text-accent" : "text-muted"}`}
        strokeWidth={1.5}
        aria-hidden
      />
    </button>
  );
}
