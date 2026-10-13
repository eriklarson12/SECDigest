import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportWatchlist,
  getWatchlist,
  importWatchlist,
  isWatched,
  parseImportParam,
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

describe("watchlist share link", () => {
  it("exports the tickers in list order with literal commas", () => {
    toggleWatch(item("AAPL"));
    toggleWatch(item("BRK.B"));
    expect(exportWatchlist("https://example.com")).toBe(
      "https://example.com/watchlist?import=BRK.B,AAPL",
    );
  });

  it("parses the import param into distinct, well-formed tickers", () => {
    expect(parseImportParam(" aapl,MSFT,,$$,aapl ,brk.b")).toEqual([
      "AAPL",
      "MSFT",
      "BRK.B",
    ]);
  });

  it("parses no more tickers than the cap", () => {
    const raw = Array.from({ length: 25 }, (_, i) => `T${i}`).join(",");
    expect(parseImportParam(raw)).toHaveLength(20);
  });

  it("merges new items in front and skips duplicates without counting them", () => {
    toggleWatch(item("AAPL"));
    const result = importWatchlist([item("MSFT"), item("AAPL"), item("NVDA")]);
    expect(result).toEqual({ added: [item("MSFT"), item("NVDA")], skipped: 0 });
    expect(getWatchlist().map((c) => c.ticker)).toEqual([
      "MSFT",
      "NVDA",
      "AAPL",
    ]);
  });

  it("reports what the cap turned away", () => {
    for (let i = 0; i < 19; i++) toggleWatch(item(`T${i}`));
    const result = importWatchlist([item("A"), item("B"), item("C")]);
    expect(result).toEqual({ added: [item("A")], skipped: 2 });
    expect(getWatchlist()).toHaveLength(20);
  });

  it("notifies subscribers once per import, and not when nothing is added", () => {
    toggleWatch(item("AAPL"));
    const listener = vi.fn();
    const unsubscribe = subscribeWatchlist(listener);
    importWatchlist([item("MSFT"), item("NVDA")]);
    expect(listener).toHaveBeenCalledTimes(1);
    importWatchlist([item("AAPL")]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("returns null and writes nothing when storage throws", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      },
    });
    expect(importWatchlist([item("AAPL")])).toBeNull();
    expect(getWatchlist()).toEqual([]);
  });
});
