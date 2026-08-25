import { describe, expect, it } from "vitest";
import {
  formatCurrency,
  formatCurrencyCompact,
  formatEps,
  formatPercent,
  formatDate,
} from "@/lib/format";

describe("formatCurrency", () => {
  it("scales trillions, billions, and millions", () => {
    expect(formatCurrency(1.23e12)).toBe("$1.23T");
    expect(formatCurrency(394328000000)).toBe("$394.33B");
    expect(formatCurrency(52_500_000)).toBe("$52.5M");
  });

  it("keeps small values as locale strings", () => {
    expect(formatCurrency(950_000)).toBe("$950,000");
  });

  it("handles negatives (net losses) and null", () => {
    expect(formatCurrency(-2.5e9)).toBe("$-2.50B");
    expect(formatCurrency(null)).toBe("N/A");
  });
});

describe("formatCurrencyCompact", () => {
  it("uses shorter precision for chart axes", () => {
    expect(formatCurrencyCompact(394328000000)).toBe("$394.3B");
    expect(formatCurrencyCompact(52_500_000)).toBe("$53M");
  });
});

describe("formatEps", () => {
  it("keeps exact cents with sign", () => {
    expect(formatEps(6.11)).toBe("$6.11");
    expect(formatEps(6.1)).toBe("$6.10");
    expect(formatEps(-0.5)).toBe("-$0.50");
  });

  it("renders null as an em dash", () => {
    expect(formatEps(null)).toBe("—");
  });
});

describe("formatPercent", () => {
  it("renders one decimal and handles null", () => {
    expect(formatPercent(5.56)).toBe("5.6%");
    expect(formatPercent(-3.2)).toBe("-3.2%");
    expect(formatPercent(null)).toBe("N/A");
  });
});

describe("formatDate", () => {
  it("keeps a calendar date on its own day", () => {
    // Parsed as UTC midnight this renders May 1 in any zone west of UTC.
    expect(formatDate("2026-05-02")).toBe("May 2, 2026");
    expect(formatDate("2026-01-01")).toBe("Jan 1, 2026");
  });

  it("renders a real timestamp in the viewer's zone, not UTC", () => {
    // Deliberately different from the case above: created_at is an instant,
    // so local is the right frame. TZ is pinned in vitest.config.ts.
    expect(formatDate("2026-07-04T00:00:00+00:00")).toBe("Jul 3, 2026");
  });

  it("tolerates null and junk", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not-a-date")).toBe("not-a-date");
  });
});
