import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addRecent, getRecent } from "@/lib/recentSearches";
import type { CompanySearchResult } from "@/lib/types";

function company(ticker: string): CompanySearchResult {
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

describe("recentSearches", () => {
  it("returns empty with nothing stored", () => {
    expect(getRecent()).toEqual([]);
  });

  it("stores most-recent first", () => {
    addRecent(company("AAPL"));
    addRecent(company("MSFT"));
    expect(getRecent().map((c) => c.ticker)).toEqual(["MSFT", "AAPL"]);
  });

  it("dedupes by ticker, moving the repeat to the front", () => {
    addRecent(company("AAPL"));
    addRecent(company("MSFT"));
    addRecent(company("AAPL"));
    expect(getRecent().map((c) => c.ticker)).toEqual(["AAPL", "MSFT"]);
  });

  it("caps at 5 entries", () => {
    for (const t of ["A", "B", "C", "D", "E", "F"]) addRecent(company(t));
    expect(getRecent().map((c) => c.ticker)).toEqual(["F", "E", "D", "C", "B"]);
  });

  it("ignores corrupted storage", () => {
    window.localStorage.setItem("secdigest.recentSearches", "{not json");
    expect(getRecent()).toEqual([]);
    window.localStorage.setItem("secdigest.recentSearches", '{"a":1}');
    expect(getRecent()).toEqual([]);
  });

  it("no-ops when storage throws (private browsing)", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      },
    });
    expect(() => addRecent(company("AAPL"))).not.toThrow();
    expect(getRecent()).toEqual([]);
  });

  it("is a no-op during SSR (no window)", () => {
    vi.unstubAllGlobals();
    expect(getRecent()).toEqual([]);
    expect(() => addRecent(company("AAPL"))).not.toThrow();
  });
});
