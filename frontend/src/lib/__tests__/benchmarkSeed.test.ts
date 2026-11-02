import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ROWS, parseTickers, resolveSeed } from "@/lib/benchmarkSeed";
import type { CompanySearchResult } from "@/lib/types";

const { getPeers, searchCompanies } = vi.hoisted(() => ({
  getPeers: vi.fn(),
  searchCompanies: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ getPeers, searchCompanies }));

const company = (ticker: string): CompanySearchResult => ({
  ticker,
  cik: `${ticker.length}000`,
  name: `${ticker} Inc.`,
});

beforeEach(() => {
  getPeers.mockReset();
  searchCompanies.mockReset();
  // Prefix search, as the real endpoint does: an exact match is not always first.
  searchCompanies.mockImplementation(async (q: string) => [
    company(`${q}X`),
    company(q),
  ]);
});

describe("parseTickers", () => {
  it("upper-cases, drops junk and de-duplicates in order", () => {
    expect(parseTickers(" msft, AAPL,,../x, msft ,brk.b")).toEqual([
      "MSFT",
      "AAPL",
      "BRK.B",
    ]);
  });
});

describe("resolveSeed", () => {
  it("returns null with no seed params, so the watchlist is used", async () => {
    expect(await resolveSeed("", "")).toBeNull();
    expect(searchCompanies).not.toHaveBeenCalled();
  });

  it("a peer seed caps the rows and names its industry", async () => {
    const peers = Array.from({ length: MAX_ROWS + 2 }, (_, i) =>
      company(`P${i}`),
    );
    getPeers.mockResolvedValue({
      cik: "4000",
      sic: "3571",
      sic_description: "Electronic Computers",
      peers,
    });
    const seed = await resolveSeed("AAPL", "MSFT");
    expect(seed?.companies).toEqual(peers.slice(0, MAX_ROWS));
    expect(seed?.truncated).toBe(true);
    expect(seed?.industry).toContain("Electronic Computers");
  });

  it("a peer seed that fails falls through to ?only=", async () => {
    getPeers.mockRejectedValue(new Error("502"));
    const seed = await resolveSeed("AAPL", "MSFT,GOOG");
    expect(seed).toEqual({
      companies: [company("MSFT"), company("GOOG")],
      truncated: false,
      industry: null,
    });
  });

  it("an ?only= set keeps its order and drops what does not resolve", async () => {
    searchCompanies.mockImplementation(async (q: string) =>
      q === "NOPE" ? [] : [company(q)],
    );
    const seed = await resolveSeed("", "GOOG,NOPE,MSFT");
    expect(seed?.companies.map((c) => c.ticker)).toEqual(["GOOG", "MSFT"]);
  });

  it("an ?only= set nobody can resolve returns null", async () => {
    searchCompanies.mockResolvedValue([]);
    expect(await resolveSeed("", "NOPE")).toBeNull();
  });
});
