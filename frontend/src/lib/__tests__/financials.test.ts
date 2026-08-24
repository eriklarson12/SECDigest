import { describe, expect, it } from "vitest";
import {
  buildAnnualPoints,
  buildQuarterlyPoints,
  hasAnnualMetrics,
  mergeTrendPoints,
} from "@/lib/financials";
import type { AnnualFinancials, QuarterlyFinancials, TrendPoint } from "@/lib/types";

function year(overrides: Partial<AnnualFinancials>): AnnualFinancials {
  return {
    fiscal_year: 2024,
    revenue: null,
    net_income: null,
    eps_diluted: null,
    operating_cash_flow: null,
    cash: null,
    total_assets: null,
    stockholders_equity: null,
    ...overrides,
  };
}

function quarter(overrides: Partial<QuarterlyFinancials>): QuarterlyFinancials {
  return { period_end: "2024-06-30", revenue: null, net_income: null, ...overrides };
}

describe("buildAnnualPoints", () => {
  it("maps fiscal year to a FY-prefixed label", () => {
    expect(buildAnnualPoints([year({ fiscal_year: 2023, revenue: 100 })])).toEqual([
      { label: "FY2023", revenue: 100, netIncome: null },
    ]);
  });

  it("keeps a year with only net_income present", () => {
    expect(buildAnnualPoints([year({ net_income: 50 })])).toHaveLength(1);
  });

  it("drops a year with both revenue and net_income null", () => {
    expect(buildAnnualPoints([year({})])).toEqual([]);
  });
});

describe("buildQuarterlyPoints", () => {
  it("formats the period end date as the label", () => {
    const [point] = buildQuarterlyPoints([
      quarter({ period_end: "2024-06-30", revenue: 10 }),
    ]);
    expect(point.label).toMatch(/Jun \d{1,2}, 2024/);
    expect(point.revenue).toBe(10);
    expect(point.netIncome).toBeNull();
  });

  it("drops a quarter with both revenue and net_income null", () => {
    expect(buildQuarterlyPoints([quarter({})])).toEqual([]);
  });
});

describe("hasAnnualMetrics", () => {
  it("is false when only revenue and net income are present", () => {
    expect(hasAnnualMetrics([year({ revenue: 100, net_income: 20 })])).toBe(false);
  });

  it("is true for a balance-sheet-only year", () => {
    expect(hasAnnualMetrics([year({ total_assets: 350 })])).toBe(true);
    expect(hasAnnualMetrics([year({ cash: 30 })])).toBe(true);
    expect(hasAnnualMetrics([year({ stockholders_equity: 60 })])).toBe(true);
  });

  it("is true when any single year carries an extra figure", () => {
    expect(hasAnnualMetrics([year({}), year({ eps_diluted: 6.1 })])).toBe(true);
  });

  it("is false for an empty series", () => {
    expect(hasAnnualMetrics([])).toBe(false);
  });
});

describe("mergeTrendPoints", () => {
  function point(label: string, revenue: number, netIncome: number): TrendPoint {
    return { label, revenue, netIncome };
  }

  it("merges a shared year into one row", () => {
    const rows = mergeTrendPoints([point("FY2024", 10, 1)], [point("FY2024", 20, 2)]);
    expect(rows).toEqual([
      { label: "FY2024", aRevenue: 10, aNetIncome: 1, bRevenue: 20, bNetIncome: 2 },
    ]);
  });

  it("leaves the other side null for a year only one company reports", () => {
    const rows = mergeTrendPoints([point("FY2023", 10, 1)], [point("FY2024", 20, 2)]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      label: "FY2023",
      aRevenue: 10,
      aNetIncome: 1,
      bRevenue: null,
      bNetIncome: null,
    });
    expect(rows[1].aRevenue).toBeNull();
    expect(rows[1].bRevenue).toBe(20);
  });

  it("returns rows in ascending fiscal-year order regardless of input order", () => {
    const rows = mergeTrendPoints(
      [point("FY2025", 3, 0), point("FY2023", 1, 0)],
      [point("FY2024", 2, 0)]
    );
    expect(rows.map((r) => r.label)).toEqual(["FY2023", "FY2024", "FY2025"]);
  });

  it("keeps disjoint ranges separate rather than aligning them by position", () => {
    const rows = mergeTrendPoints(
      [point("FY2020", 1, 0), point("FY2021", 2, 0)],
      [point("FY2024", 9, 0), point("FY2025", 8, 0)]
    );
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.aRevenue !== null && r.bRevenue !== null)).toEqual([]);
  });

  it("is empty when neither company has points", () => {
    expect(mergeTrendPoints([], [])).toEqual([]);
  });
});
