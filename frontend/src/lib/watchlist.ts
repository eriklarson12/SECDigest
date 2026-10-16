import type { WatchItem } from "./types";
import { TICKER_RE } from "./ticker";

/** Watchlist lives in localStorage by design — no accounts, no backend state
 * (tasks/roadmap.md 2.1). Same SSR/private-browsing guards as recentSearches. */

const KEY = "secdigest.watchlist";
export const MAX_ITEMS = 20;

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
        typeof c?.name === "string",
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

/** The share link (roadmap 14.2). It carries tickers only: the receiving side
 * resolves names through search, so a link cannot plant a made-up name. */
export function exportWatchlist(origin: string): string {
  const tickers = getWatchlist().map((c) => c.ticker);
  return `${origin}/watchlist?import=${tickers.join(",")}`;
}

/** The `?import=` value as distinct, well-formed tickers. Anything past the cap
 * could never be added, so it is not looked up either. */
export function parseImportParam(raw: string): string[] {
  const tickers = raw
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => TICKER_RE.test(t));
  return [...new Set(tickers)].slice(0, MAX_ITEMS);
}

/** Merge into the current list, newest first like `toggleWatch`. A ticker
 * already watched is neither added nor counted as skipped; `skipped` is what the
 * cap turned away. Null when storage is unavailable, which an empty `added`
 * would misreport as "all already watched". */
export function importWatchlist(
  items: WatchItem[],
): { added: WatchItem[]; skipped: number } | null {
  const current = getWatchlist();
  const watched = new Set(current.map((c) => c.ticker));
  const fresh = items.filter(
    (item, i) =>
      !watched.has(item.ticker) &&
      items.findIndex((other) => other.ticker === item.ticker) === i,
  );
  const added = fresh.slice(0, Math.max(0, MAX_ITEMS - current.length));
  if (added.length > 0) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify([...added, ...current]));
    } catch {
      return null;
    }
    emit();
  }
  return { added, skipped: fresh.length - added.length };
}
