import type { WatchItem } from "./types";

/** Watchlist lives in localStorage by design — no accounts, no backend state
 * (tasks/roadmap.md 2.1). Same SSR/private-browsing guards as recentSearches. */

const KEY = "secdigest.watchlist";
const MAX_ITEMS = 20;

// Star buttons across the page stay in sync via a subscriber list
// (useSyncExternalStore-compatible).
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function subscribeWatchlist(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getWatchlist(): WatchItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is WatchItem =>
        typeof c?.ticker === "string" &&
        typeof c?.cik === "string" &&
        typeof c?.name === "string"
    );
  } catch {
    return [];
  }
}

export function isWatched(ticker: string): boolean {
  return getWatchlist().some((c) => c.ticker === ticker);
}

/** Add or remove; returns the new list. Adds beyond the cap are ignored. */
export function toggleWatch(item: WatchItem): WatchItem[] {
  const current = getWatchlist();
  let next: WatchItem[];
  if (current.some((c) => c.ticker === item.ticker)) {
    next = current.filter((c) => c.ticker !== item.ticker);
  } else if (current.length >= MAX_ITEMS) {
    return current;
  } else {
    next = [item, ...current];
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      return current; // storage unavailable — stars no-op
    }
  }
  emit();
  return next;
}
