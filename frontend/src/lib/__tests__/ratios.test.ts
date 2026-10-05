import { describe, expect, it } from "vitest";
import { formatMultiple } from "@/lib/format";
import {
  buildBenchmarkRow,
  currentRatio,
  fcfMargin,
  freeCashFlow,
  grossMargin,
  latestYear,
  liabilitiesToEquity,
  operatingMargin,
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

// AAPL FY2025 as tagged: OCF $111.482B less capex $12.715B is the $98.767B its cash-flow statement gives.
const AAPL_2025 = year(2025, {
  revenue: 416_161e6,
  operating_cash_flow: 111_482e6,
  capex: 12_715e6,
  gross_profit: 195_201e6,
  operating_income: 133_050e6,
  liabilities: 285_508e6,
  stockholders_equity: 66_796e6,
  current_assets: 147_957e6,
  current_liabilities: 165_631e6,
});

// JPM's shape: no capex, gross profit, operating income or classified balance sheet.
const BANK = year(2025, {
  revenue: 180_000e6,
  operating_cash_flow: -147_782e6,
  liabilities: 4_062_462e6,
  stockholders_equity: 356_924e6,
});

describe("freeCashFlow / fcfMargin", () => {
  it("is operating cash flow less capex", () => {
    expect(freeCashFlow(AAPL_2025)).toBe(98_767e6);
    expect(fcfMargin(AAPL_2025)).toBeCloseTo(23.73, 2);
  });

  it("is null, never OCF alone, when capex is untagged", () => {
    expect(freeCashFlow(BANK)).toBeNull();
    expect(fcfMargin(BANK)).toBeNull();
  });

  it("is null when operating cash flow is untagged", () => {
    expect(freeCashFlow(year(2025, { capex: 5 }))).toBeNull();
  });

  it("is null with no year, and reads an older payload's missing field as null", () => {
    expect(freeCashFlow(null)).toBeNull();
    expect(freeCashFlow({ ...AAPL_2025, capex: undefined })).toBeNull();
  });
});

describe("grossMargin / operatingMargin", () => {
  it("returns whole percents", () => {
    expect(grossMargin(AAPL_2025)).toBeCloseTo(46.91, 2);
    expect(operatingMargin(AAPL_2025)).toBeCloseTo(31.97, 2);
  });

  it("is null, not 0, for a filer reporting no such subtotal", () => {
    expect(grossMargin(BANK)).toBeNull();
    expect(operatingMargin(BANK)).toBeNull();
  });

  it("is null over a zero or negative revenue", () => {
    expect(grossMargin(year(2025, { revenue: 0, gross_profit: 5 }))).toBeNull();
    expect(operatingMargin(year(2025, { revenue: -1, operating_income: 5 }))).toBeNull();
  });
});

describe("liabilitiesToEquity / currentRatio", () => {
  it("divides the balance-sheet figures", () => {
    expect(liabilitiesToEquity(AAPL_2025)).toBeCloseTo(4.27, 2);
    expect(currentRatio(AAPL_2025)).toBeCloseTo(0.89, 2);
  });

  it("is null for a bank's unclassified balance sheet, not 0", () => {
    expect(currentRatio(BANK)).toBeNull();
    expect(liabilitiesToEquity(BANK)).toBeCloseTo(11.38, 2);
  });

  it("is null over zero or negative equity", () => {
    expect(liabilitiesToEquity(year(2025, { liabilities: 10, stockholders_equity: 0 }))).toBeNull();
    expect(liabilitiesToEquity(year(2025, { liabilities: 10, stockholders_equity: -4 }))).toBeNull();
  });

  it("is null over zero current liabilities", () => {
    expect(currentRatio(year(2025, { current_assets: 10, current_liabilities: 0 }))).toBeNull();
  });

  it("is null with no year", () => {
    expect(liabilitiesToEquity(null)).toBeNull();
    expect(currentRatio(null)).toBeNull();
  });
});

describe("formatMultiple", () => {
  it("keeps two decimals and a times sign", () => {
    expect(formatMultiple(4.2744)).toBe("4.27×");
    expect(formatMultiple(0.8933)).toBe("0.89×");
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
      revisions: [],
      percentiles: [
        {
          metric: "revenue",
          concept: "Revenues",
          period: "CY2025",
          period_end: "2025-12-31",
          value: 1331,
          percentile: 95.8,
          population: 4665,
        },
      ],
    });

    expect(row.state).toBe("ready");
    expect(row.fiscalYear).toBe(2025);
    expect(row.revenue).toBe(1331);
    expect(row.netMargin).toBeCloseTo(20, 10);
    expect(row.ocfMargin).toBeCloseTo(30, 10);
    expect(row.revenueCagr).toBeCloseTo(10, 10);
    // An income-statement-only year leaves every balance-sheet ratio blank.
    expect(row.liabilitiesToEquity).toBeNull();
    expect(row.currentRatio).toBeNull();
    // Free of a request: it rode in on the same response as the figures above.
    expect(row.revenuePercentile).toBe(95.8);
  });

  it("reads the derived ratios off the latest year", () => {
    const row = buildBenchmarkRow(AAPL, {
      cik: AAPL.cik,
      years: [AAPL_2025],
      quarters: [],
      revisions: [],
      percentiles: [],
    });

    expect(row.grossMargin).toBeCloseTo(46.91, 2);
    expect(row.operatingMargin).toBeCloseTo(31.97, 2);
    expect(row.fcfMargin).toBeCloseTo(23.73, 2);
    expect(row.liabilitiesToEquity).toBeCloseTo(4.27, 2);
    expect(row.currentRatio).toBeCloseTo(0.89, 2);
  });

  it("degrades to nulls for a company with no tagged years", () => {
    const row = buildBenchmarkRow(AAPL, {
      cik: AAPL.cik,
      years: [],
      quarters: [],
      revisions: [],
      percentiles: [],
    });

    expect(row.state).toBe("ready");
    expect(row.fiscalYear).toBeNull();
    expect(row.netMargin).toBeNull();
    expect(row.revenueCagr).toBeNull();
    // A filer absent from the population has no rank, rather than a last place it never took.
    expect(row.revenuePercentile).toBeNull();
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
      grossMargin: null,
      operatingMargin: null,
      fcfMargin: null,
      liabilitiesToEquity: null,
      currentRatio: null,
      revenueCagr: null,
      revenuePercentile: null,
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

  it("sorts the derived ratios, sinking a bank's blank current ratio", () => {
    const bank = row({ ticker: "JPM", cik: "19617", name: "JPMorgan Chase" }, {
      liabilitiesToEquity: 11.4,
    });
    const withRatios = [
      row(AAPL, { currentRatio: 0.9, liabilitiesToEquity: 4.3 }),
      row(MSFT, { currentRatio: 1.4, liabilitiesToEquity: 0.9 }),
      bank,
    ];
    expect(tickers(sortBenchmarkRows(withRatios, "currentRatio", "asc"))).toEqual([
      "AAPL",
      "MSFT",
      "JPM",
    ]);
    expect(tickers(sortBenchmarkRows(withRatios, "liabilitiesToEquity", "desc"))).toEqual([
      "JPM",
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
