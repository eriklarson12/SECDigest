import { describe, expect, it } from "vitest";
import { analysisIdFor, analyzedByAccession, hasNewerFiling, findPriorFiling } from "@/lib/filings";

describe("hasNewerFiling", () => {
  it("is false when EDGAR returned no filing", () => {
    expect(hasNewerFiling(null, "2026-05-02")).toBe(false);
    expect(hasNewerFiling(undefined, "2026-05-02")).toBe(false);
  });

  it("is true when a filing exists but nothing has been analyzed", () => {
    expect(hasNewerFiling("2026-05-02", null)).toBe(true);
  });

  it("is true when the filing postdates the analysis", () => {
    expect(hasNewerFiling("2026-08-01", "2026-05-02")).toBe(true);
  });

  it("is false when the analysis already covers the latest filing", () => {
    expect(hasNewerFiling("2026-05-02", "2026-05-02")).toBe(false);
  });

  it("is false when the analysis is ahead of the filing", () => {
    expect(hasNewerFiling("2026-05-02", "2026-08-01")).toBe(false);
  });

  it("compares across year and month boundaries without date parsing", () => {
    expect(hasNewerFiling("2026-01-02", "2025-12-31")).toBe(true);
    expect(hasNewerFiling("2025-12-31", "2026-01-02")).toBe(false);
  });
});

describe("analyzedByAccession", () => {
  const stored = analyzedByAccession([
    { id: 150, accession_number: "000032019326000057" },
    { id: 151, accession_number: "0000320193-26-000068" },
  ]);

  it("matches EDGAR's dashed accession against the table's dashless one", () => {
    expect(analysisIdFor(stored, "0000320193-26-000057")).toBe(150);
  });

  it("matches whichever side carries the dashes", () => {
    expect(analysisIdFor(stored, "000032019326000068")).toBe(151);
  });

  it("is undefined for a filing nobody analyzed", () => {
    expect(analysisIdFor(stored, "0000320193-26-000099")).toBeUndefined();
  });
});

describe("findPriorFiling", () => {
  const filing = (form_type: string, filing_date: string) => ({ form_type, filing_date });
  const feed = [
    filing("10-Q", "2026-05-02"),
    filing("10-Q/A", "2026-03-01"),
    filing("10-Q", "2026-01-30"),
    filing("10-K", "2025-10-31"),
    filing("10-Q", "2025-08-01"),
  ];

  it("picks the newest same-form filing before the analysis", () => {
    expect(
      findPriorFiling(feed, { form_type: "10-Q", filing_date: "2026-05-02" }),
    ).toEqual(filing("10-Q", "2026-01-30"));
  });

  it("never offers another form or an amendment", () => {
    expect(
      findPriorFiling(feed, { form_type: "10-K", filing_date: "2025-10-31" }),
    ).toBeNull();
  });

  it("is null without a filing date to measure from", () => {
    expect(findPriorFiling(feed, { form_type: "10-Q", filing_date: null })).toBeNull();
  });
});
