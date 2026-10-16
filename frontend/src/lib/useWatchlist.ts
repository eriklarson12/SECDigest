"use client";

import { useSyncExternalStore } from "react";
import { subscribeWatchlist, watchlistSnapshot } from "./watchlist";
import type { WatchItem } from "./types";

/** The live watchlist. Null while hydrating, since the server has no localStorage. */
export function useWatchlist(): WatchItem[] | null {
  return useSyncExternalStore(subscribeWatchlist, watchlistSnapshot, () => null);
}
