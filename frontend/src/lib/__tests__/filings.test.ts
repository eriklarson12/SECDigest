import { describe, expect, it } from "vitest";
import { analysisIdFor, analyzedByAccession, hasNewerFiling } from "@/lib/filings";

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
