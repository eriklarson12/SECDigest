import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWatchlist,
  isWatched,
  subscribeWatchlist,
  toggleWatch,
} from "@/lib/watchlist";
import type { WatchItem } from "@/lib/types";

function item(ticker: string): WatchItem {
  return { ticker, cik: "123", name: `${ticker} Inc.` };
}

function makeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: makeStorage() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("watchlist", () => {
  it("starts empty", () => {
    expect(getWatchlist()).toEqual([]);
    expect(isWatched("AAPL")).toBe(false);
  });

  it("toggle adds then removes", () => {
    toggleWatch(item("AAPL"));
    expect(isWatched("AAPL")).toBe(true);
    toggleWatch(item("AAPL"));
    expect(isWatched("AAPL")).toBe(false);
    expect(getWatchlist()).toEqual([]);
  });

  it("newest additions go first and persist", () => {
    toggleWatch(item("AAPL"));
    toggleWatch(item("MSFT"));
    expect(getWatchlist().map((c) => c.ticker)).toEqual(["MSFT", "AAPL"]);
  });

  it("caps at 20 items — extra adds are ignored", () => {
    for (let i = 0; i < 20; i++) toggleWatch(item(`T${i}`));
    const before = getWatchlist();
    const result = toggleWatch(item("OVERFLOW"));
    expect(result).toEqual(before);
    expect(isWatched("OVERFLOW")).toBe(false);
  });

  it("removal still works at the cap", () => {
    for (let i = 0; i < 20; i++) toggleWatch(item(`T${i}`));
    toggleWatch(item("T5"));
    expect(isWatched("T5")).toBe(false);
    expect(getWatchlist()).toHaveLength(19);
  });

  it("notifies subscribers on toggle", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWatchlist(listener);
    toggleWatch(item("AAPL"));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    toggleWatch(item("MSFT"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ignores corrupted storage", () => {
    window.localStorage.setItem("secdigest.watchlist", "not json at all");
    expect(getWatchlist()).toEqual([]);
  });

  it("returns the unchanged list when storage throws (private browsing)", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      },
    });
    expect(toggleWatch(item("AAPL"))).toEqual([]);
    expect(isWatched("AAPL")).toBe(false);
  });
});
