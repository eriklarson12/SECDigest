import { describe, expect, it } from "vitest";
import {
  formatCurrency,
  formatCurrencyCompact,
  formatEps,
  formatPercent,
  formatDate,
  formatRelativeTime,
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

describe("formatRelativeTime", () => {
  const NOW = new Date("2026-08-28T12:00:00Z").getTime();
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it("collapses anything under a minute", () => {
    expect(formatRelativeTime(ago(30 * 1000), NOW)).toBe("just now");
    expect(formatRelativeTime(ago(59 * 1000), NOW)).toBe("just now");
  });

  it("steps up through minutes, hours, and days", () => {
    expect(formatRelativeTime(ago(MINUTE), NOW)).toBe("1 minute ago");
    expect(formatRelativeTime(ago(5 * MINUTE), NOW)).toBe("5 minutes ago");
    expect(formatRelativeTime(ago(HOUR), NOW)).toBe("1 hour ago");
    expect(formatRelativeTime(ago(3 * HOUR), NOW)).toBe("3 hours ago");
    expect(formatRelativeTime(ago(DAY), NOW)).toBe("yesterday");
    expect(formatRelativeTime(ago(5 * DAY), NOW)).toBe("5 days ago");
  });

  it("truncates rather than rounds, so a unit is never claimed early", () => {
    // 119 minutes is still "1 hour ago" — reporting 2 would overstate the age
    expect(formatRelativeTime(ago(119 * MINUTE), NOW)).toBe("1 hour ago");
  });

  it("hands off to a date at 30 days", () => {
    expect(formatRelativeTime(ago(29 * DAY), NOW)).toBe("29 days ago");
    expect(formatRelativeTime(ago(30 * DAY), NOW)).toBe("on Jul 29, 2026");
    expect(formatRelativeTime(ago(40 * DAY), NOW)).toBe("on Jul 19, 2026");
  });

  it("reads a skewed clock as the present, not the future", () => {
    expect(formatRelativeTime(ago(-2 * HOUR), NOW)).toBe("just now");
  });

  it("tolerates null and junk like formatDate does", () => {
    expect(formatRelativeTime(null, NOW)).toBe("—");
    expect(formatRelativeTime("not-a-date", NOW)).toBe("not-a-date");
  });
});
