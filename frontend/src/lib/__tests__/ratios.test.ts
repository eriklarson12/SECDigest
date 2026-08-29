import { describe, expect, it } from "vitest";
import {
  buildBenchmarkRow,
  latestYear,
  netMargin,
  ocfMargin,
  revenueCagr,
  sortBenchmarkRows,
  type BenchmarkRow,
} from "@/lib/ratios";
import type { AnnualFinancials, WatchItem } from "@/lib/types";

const AAPL: WatchItem = { ticker: "AAPL", cik: "320193", name: "Apple Inc." };
const MSFT: WatchItem = {
  ticker: "MSFT",
  cik: "789019",
  name: "Microsoft Corporation",
};

function year(
  fiscal_year: number,
  patch: Partial<AnnualFinancials> = {},
): AnnualFinancials {
  return {
    fiscal_year,
    revenue: null,
    net_income: null,
    eps_diluted: null,
    operating_cash_flow: null,
    cash: null,
    total_assets: null,
    stockholders_equity: null,
    ...patch,
  };
}

describe("latestYear", () => {
  it("picks the highest fiscal year regardless of payload order", () => {
    const years = [
      year(2024, { revenue: 200 }),
      year(2025, { revenue: 300 }),
      year(2023, { revenue: 100 }),
    ];

    expect(latestYear(years)?.fiscal_year).toBe(2025);
  });

  it("skips a year that carries no figure at all", () => {
    const years = [year(2024, { revenue: 200 }), year(2025)];

    expect(latestYear(years)?.fiscal_year).toBe(2024);
  });

  it("counts a balance-sheet-only year as usable", () => {
    expect(latestYear([year(2025, { cash: 10 })])?.fiscal_year).toBe(2025);
  });

  it("is null for an empty series", () => {
    expect(latestYear([])).toBeNull();
  });
});

describe("netMargin / ocfMargin", () => {
  it("returns whole percents", () => {
    expect(netMargin(year(2025, { revenue: 1000, net_income: 200 }))).toBe(20);
    expect(
      ocfMargin(year(2025, { revenue: 1000, operating_cash_flow: 350 })),
    ).toBe(35);
  });

  it("keeps the sign on a loss", () => {
    expect(netMargin(year(2025, { revenue: 1000, net_income: -250 }))).toBe(-25);
  });

  it("is null when the numerator is missing", () => {
    expect(netMargin(year(2025, { revenue: 1000 }))).toBeNull();
    expect(ocfMargin(year(2025, { revenue: 1000 }))).toBeNull();
  });

  it("is null when revenue is missing", () => {
    expect(netMargin(year(2025, { net_income: 200 }))).toBeNull();
  });

  /** Not Infinity, and not a huge number — a ratio over a non-positive
   * denominator has no meaning to render. */
  it("is null for a zero or negative denominator", () => {
    expect(netMargin(year(2025, { revenue: 0, net_income: 200 }))).toBeNull();
    expect(netMargin(year(2025, { revenue: -50, net_income: 200 }))).toBeNull();
  });

  it("is null with no year at all", () => {
    expect(netMargin(null)).toBeNull();
    expect(ocfMargin(null)).toBeNull();
  });
});

describe("revenueCagr", () => {
  const clean = [
    year(2022, { revenue: 1000 }),
    year(2023, { revenue: 1100 }),
    year(2024, { revenue: 1210 }),
    year(2025, { revenue: 1331 }),
  ];

  it("compounds across exactly three years", () => {
    // 1000 → 1331 over 3 years is 10% a year
    expect(revenueCagr(clean)).toBeCloseTo(10, 10);
  });

  it("does not depend on payload order", () => {
    expect(revenueCagr([...clean].reverse())).toBeCloseTo(10, 10);
  });

  /** A shorter span under a "3-yr" header would be a wrong number where a blank
   * is an honest one. */
  it("is null when the start year is absent", () => {
    expect(revenueCagr(clean.slice(1))).toBeNull();
  });

  it("is null when the start year exists but tags no revenue", () => {
    expect(revenueCagr([year(2022), ...clean.slice(1)])).toBeNull();
  });

  it("is null from a zero or negative base", () => {
    expect(
      revenueCagr([year(2022, { revenue: 0 }), ...clean.slice(1)]),
    ).toBeNull();
    expect(
      revenueCagr([year(2022, { revenue: -10 }), ...clean.slice(1)]),
    ).toBeNull();
  });

  it("is null for a single year and for an empty series", () => {
    expect(revenueCagr([year(2025, { revenue: 100 })])).toBeNull();
    expect(revenueCagr([])).toBeNull();
  });

  it("honours a custom span", () => {
    expect(revenueCagr(clean, 1)).toBeCloseTo(10, 10);
  });

  it("reports a decline as negative", () => {
    const falling = [
      year(2022, { revenue: 1331 }),
      year(2025, { revenue: 1000 }),
    ];

    expect(revenueCagr(falling)).toBeCloseTo(-9.0909, 3);
  });
});

describe("buildBenchmarkRow", () => {
  it("reads every column off the latest year plus the CAGR span", () => {
    const row = buildBenchmarkRow(AAPL, {
      cik: AAPL.cik,
      years: [
        year(2022, { revenue: 1000 }),
        year(2025, {
          revenue: 1331,
          net_income: 266.2,
          operating_cash_flow: 399.3,
        }),
      ],
      quarters: [],
    });

    expect(row.state).toBe("ready");
    expect(row.fiscalYear).toBe(2025);
    expect(row.revenue).toBe(1331);
    expect(row.netMargin).toBeCloseTo(20, 10);
    expect(row.ocfMargin).toBeCloseTo(30, 10);
    expect(row.revenueCagr).toBeCloseTo(10, 10);
  });

  it("degrades to nulls for a company with no tagged years", () => {
    const row = buildBenchmarkRow(AAPL, {
      cik: AAPL.cik,
      years: [],
      quarters: [],
    });

    expect(row.state).toBe("ready");
    expect(row.fiscalYear).toBeNull();
    expect(row.netMargin).toBeNull();
    expect(row.revenueCagr).toBeNull();
  });
});

describe("sortBenchmarkRows", () => {
  function row(
    item: WatchItem,
    patch: Partial<BenchmarkRow> = {},
  ): BenchmarkRow {
    return {
      item,
      state: "ready",
      fiscalYear: 2025,
      revenue: null,
      netMargin: null,
      ocfMargin: null,
      revenueCagr: null,
      ...patch,
    };
  }

  const a = row(AAPL, { netMargin: 20, revenue: 300 });
  const b = row(MSFT, { netMargin: 35, revenue: 100 });
  const missing = row(
    { ticker: "ZZZZ", cik: "1", name: "Nothing Corp" },
    { state: "error", fiscalYear: null },
  );

  function tickers(rows: BenchmarkRow[]): string[] {
    return rows.map((r) => r.item.ticker);
  }

  it("sorts a numeric column both ways", () => {
    expect(tickers(sortBenchmarkRows([a, b], "netMargin", "desc"))).toEqual([
      "MSFT",
      "AAPL",
    ]);
    expect(tickers(sortBenchmarkRows([a, b], "netMargin", "asc"))).toEqual([
      "AAPL",
      "MSFT",
    ]);
  });

  it("sorts each numeric column on its own values", () => {
    expect(tickers(sortBenchmarkRows([a, b], "revenue", "desc"))).toEqual([
      "AAPL",
      "MSFT",
    ]);
  });

  it("sorts tickers alphabetically", () => {
    expect(tickers(sortBenchmarkRows([b, a], "ticker", "asc"))).toEqual([
      "AAPL",
      "MSFT",
    ]);
    expect(tickers(sortBenchmarkRows([a, b], "ticker", "desc"))).toEqual([
      "MSFT",
      "AAPL",
    ]);
  });

  /** A missing figure is not the smallest one — a company that tags no OCF is
   * absent from that ranking, not bottom of it. */
  it("sinks nulls in both directions", () => {
    expect(
      tickers(sortBenchmarkRows([missing, a, b], "netMargin", "desc")).at(-1),
    ).toBe("ZZZZ");
    expect(
      tickers(sortBenchmarkRows([missing, a, b], "netMargin", "asc")).at(-1),
    ).toBe("ZZZZ");
  });

  it("keeps an error row reachable by ticker sort", () => {
    expect(tickers(sortBenchmarkRows([a, missing, b], "ticker", "asc"))).toEqual(
      ["AAPL", "MSFT", "ZZZZ"],
    );
  });

  it("does not mutate its input", () => {
    const rows = [a, b];
    sortBenchmarkRows(rows, "netMargin", "desc");

    expect(tickers(rows)).toEqual(["AAPL", "MSFT"]);
  });
});
