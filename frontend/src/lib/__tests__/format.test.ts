import { describe, expect, it } from "vitest";
import {
  formatCurrency,
  formatCurrencyCompact,
  formatEps,
  formatIndustry,
  formatPercent,
  formatSector,
  compareSectors,
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

describe("formatIndustry", () => {
  it("names the code alongside the description", () => {
    expect(formatIndustry("3571", "Electronic Computers")).toBe(
      "SIC 3571 · Electronic Computers",
    );
  });

  it("keeps a zero-padded code intact", () => {
    expect(formatIndustry("0700", "Agricultural Services")).toBe(
      "SIC 0700 · Agricultural Services",
    );
  });

  // The two fields go missing independently — never render a dangling separator.
  it("renders a code with no description", () => {
    expect(formatIndustry("3571", null)).toBe("SIC 3571");
  });

  it("renders a description with no code", () => {
    expect(formatIndustry(null, "Electronic Computers")).toBe(
      "Electronic Computers",
    );
  });

  it("returns null when there is nothing to say", () => {
    expect(formatIndustry(null, null)).toBeNull();
    expect(formatIndustry("", "")).toBeNull();
  });
});

describe("formatSector", () => {
  it("drops the office number, which is a sort key and not part of the name", () => {
    expect(formatSector("06 Technology")).toBe("Technology");
    expect(formatSector("02 Finance")).toBe("Finance");
  });

  // Measured against live EDGAR in roadmap 8.1: ownerOrg is not always "NN Name".
  it("leaves an unnumbered office alone", () => {
    expect(formatSector("International Corp Fin")).toBe("International Corp Fin");
  });

  it("names the bucket for rows EDGAR never classified", () => {
    expect(formatSector(null)).toBe("Unclassified");
    // Absent EDGAR fields arrive as empty strings, not nulls.
    expect(formatSector("")).toBe("Unclassified");
    expect(formatSector("   ")).toBe("Unclassified");
  });

  it("keeps a value that is only digits rather than emptying it", () => {
    expect(formatSector("06")).toBe("06");
  });
});

describe("compareSectors", () => {
  const order = (values: (string | null)[]) => [...values].sort(compareSectors);

  it("follows SEC's own office numbering", () => {
    expect(order(["06 Technology", "02 Finance", "04 Manufacturing"])).toEqual([
      "02 Finance",
      "04 Manufacturing",
      "06 Technology",
    ]);
  });

  // On a plain string sort a letter beats a digit and this would lead the list.
  it("puts an unnumbered office after every numbered one", () => {
    expect(order(["International Corp Fin", "02 Finance"])).toEqual([
      "02 Finance",
      "International Corp Fin",
    ]);
  });

  it("sorts unnumbered offices among themselves alphabetically", () => {
    expect(order(["International Corp Fin", "Crypto Assets"])).toEqual([
      "Crypto Assets",
      "International Corp Fin",
    ]);
  });

  it("trails the unclassified bucket whatever else is present", () => {
    expect(order([null, "06 Technology", "International Corp Fin"])).toEqual([
      "06 Technology",
      "International Corp Fin",
      null,
    ]);
    expect(order(["06 Technology", null])).toEqual(["06 Technology", null]);
  });

  it("handles a corpus with nothing in it", () => {
    expect(order([])).toEqual([]);
    expect(order([null])).toEqual([null]);
  });
});
