import { describe, expect, it } from "vitest";

import { hasBreakdown, periodLabel, shareOf } from "@/lib/segments";
import type { RevenueSplit, SegmentRevenue } from "@/lib/types";

const SPLIT: RevenueSplit = {
  concept: "us-gaap:Revenues",
  total: 300,
  rows: [
    { member: "x:AMember", label: "A", value: 200 },
    { member: "x:BMember", label: "B", value: 100 },
  ],
  reconciling: [],
};

function revenue(overrides: Partial<SegmentRevenue> = {}): SegmentRevenue {
  return {
    period_start: "2024-09-29",
    period_end: "2025-09-27",
    segments: SPLIT,
    geography: null,
    ...overrides,
  };
}

describe("hasBreakdown", () => {
  it("is false for a row never computed", () => {
    expect(hasBreakdown(null)).toBe(false);
    expect(hasBreakdown(undefined)).toBe(false);
  });

  it("is false for a filing read and found to report neither split", () => {
    expect(hasBreakdown(revenue({ segments: null }))).toBe(false);
  });

  it("is true when either split is present", () => {
    expect(hasBreakdown(revenue())).toBe(true);
    expect(hasBreakdown(revenue({ segments: null, geography: SPLIT }))).toBe(true);
  });
});

describe("periodLabel", () => {
  it("names a 10-K's fiscal year", () => {
    expect(periodLabel(revenue(), "10-K")).toBe("Fiscal year ended Sep 27, 2025");
  });

  it("names a 10-Q's quarter, amendments included", () => {
    const quarter = revenue({ period_start: "2026-03-29", period_end: "2026-06-27" });
    expect(periodLabel(quarter, "10-Q")).toBe("Three months ended Jun 27, 2026");
    expect(periodLabel(quarter, "10-Q/A")).toBe("Three months ended Jun 27, 2026");
  });
});

describe("shareOf", () => {
  it("is a percent of the total", () => {
    expect(shareOf(100, 400)).toBe(25);
  });

  it("keeps a reconciling row's sign", () => {
    expect(shareOf(-3_134, 182_447)).toBeCloseTo(-1.72, 2);
  });

  it("is null against a zero total", () => {
    expect(shareOf(1, 0)).toBeNull();
  });
});
