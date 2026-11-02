import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCompany, lookupCompany } from "@/lib/companyLookup";
import type { CompanySearchResult } from "@/lib/types";

const { searchCompanies } = vi.hoisted(() => ({ searchCompanies: vi.fn() }));

vi.mock("@/lib/api", () => ({ searchCompanies }));

const company = (ticker: string): CompanySearchResult => ({
  ticker,
  cik: "320193",
  name: `${ticker} Inc.`,
});

beforeEach(() => {
  searchCompanies.mockReset();
});

describe("lookupCompany", () => {
  it("returns the exact ticker, not the first prefix match", async () => {
    searchCompanies.mockResolvedValue([company("AAX"), company("AA")]);
    expect((await lookupCompany("AA"))?.ticker).toBe("AA");
  });

  it("matches a lower-case result against the upper-cased ticker", async () => {
    searchCompanies.mockResolvedValue([company("brk.b")]);
    expect((await lookupCompany("BRK.B"))?.ticker).toBe("brk.b");
  });

  it("returns null for no match and rejects when the search fails", async () => {
    searchCompanies.mockResolvedValueOnce([company("AAPLX")]);
    expect(await lookupCompany("AAPL")).toBeNull();
    searchCompanies.mockRejectedValueOnce(new Error("down"));
    await expect(lookupCompany("AAPL")).rejects.toThrow("down");
  });
});

describe("findCompany", () => {
  it("reads a failed search as no match", async () => {
    searchCompanies.mockRejectedValueOnce(new Error("down"));
    expect(await findCompany("AAPL")).toBeNull();
  });

  it("returns the exact match when the search succeeds", async () => {
    searchCompanies.mockResolvedValueOnce([company("AAPLX"), company("AAPL")]);
    expect((await findCompany("AAPL"))?.ticker).toBe("AAPL");
  });
});
