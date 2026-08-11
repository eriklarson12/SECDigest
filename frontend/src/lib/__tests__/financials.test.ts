import { describe, expect, it } from "vitest";
import { buildAnnualPoints, buildQuarterlyPoints } from "@/lib/financials";
import type { AnnualFinancials, QuarterlyFinancials } from "@/lib/types";

function year(overrides: Partial<AnnualFinancials>): AnnualFinancials {
  return {
    fiscal_year: 2024,
    revenue: null,
    net_income: null,
    eps_diluted: null,
    operating_cash_flow: null,
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
