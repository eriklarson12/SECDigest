import { describe, expect, it } from "vitest";
import {
  findPercentile,
  formatPercentile,
  percentileBarWidth,
} from "@/lib/percentiles";
import type { Percentile } from "@/lib/types";

function entry(metric: string, percentile = 50): Percentile {
  return {
    metric,
    concept: "Revenues",
    period: "CY2025",
    period_end: "2025-12-31",
    value: 1,
    percentile,
    population: 100,
  };
}

describe("formatPercentile", () => {
  it("suffixes 1, 2 and 3 irregularly", () => {
    expect(formatPercentile(1)).toBe("1st");
    expect(formatPercentile(2)).toBe("2nd");
    expect(formatPercentile(3)).toBe("3rd");
    expect(formatPercentile(23)).toBe("23rd");
  });

  it("keeps the teens on th", () => {
    expect(formatPercentile(11)).toBe("11th");
    expect(formatPercentile(12)).toBe("12th");
    expect(formatPercentile(13)).toBe("13th");
    expect(formatPercentile(113)).toBe("113th");
  });

  it("keeps one decimal so the crowded top stays distinguishable", () => {
    // Apple at 99.94 and Microsoft at 99.92 both round to 100 without it.
    expect(formatPercentile(99.94)).toBe("99.9th");
    expect(formatPercentile(99.92)).toBe("99.9th");
  });

  it("drops a trailing zero rather than rendering 95.0th", () => {
    expect(formatPercentile(95.0)).toBe("95th");
    expect(formatPercentile(87.5)).toBe("87.5th");
  });

  it("does not read the integer part's last digit through a decimal", () => {
    // QSR's real CY2025 ranking. Suffixing off the whole number rendered "93.2rd" and "92.6nd".
    expect(formatPercentile(93.198)).toBe("93.2th");
    expect(formatPercentile(92.558)).toBe("92.6th");
    expect(formatPercentile(1.4)).toBe("1.4th");
  });
});

describe("percentileBarWidth", () => {
  it("floors the bottom of the population at a visible sliver", () => {
    // A bar that vanishes reads as missing data rather than as a low rank.
    expect(percentileBarWidth(0)).toBe(2);
    expect(percentileBarWidth(0.02)).toBe(2);
  });

  it("passes the middle through and caps the top", () => {
    expect(percentileBarWidth(45.8)).toBe(45.8);
    expect(percentileBarWidth(100)).toBe(100);
  });
});

describe("findPercentile", () => {
  it("finds by metric regardless of position", () => {
    const list = [entry("net_income", 99.9), entry("revenue", 95.8)];
    expect(findPercentile(list, "revenue")?.percentile).toBe(95.8);
  });

  it("returns null for a metric this filer never tagged", () => {
    expect(findPercentile([entry("revenue")], "operating_cash_flow")).toBeNull();
  });
});
