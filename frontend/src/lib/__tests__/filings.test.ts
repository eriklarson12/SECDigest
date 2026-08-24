import { describe, expect, it } from "vitest";
import { hasNewerFiling } from "@/lib/filings";

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
