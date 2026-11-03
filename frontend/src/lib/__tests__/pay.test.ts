import { describe, expect, it } from "vitest";
import {
  formatMeasure,
  hasMeasure,
  hasPeerTsr,
  payRows,
  sourceLine,
} from "@/lib/pay";
import type { AnnualFinancials, PayVersusPerformance, PayYear } from "@/lib/types";

const year = (overrides: Partial<PayYear>): PayYear => ({
  period_end: "2025-09-27",
  executives: [],
  tsr: 233.88,
  peer_tsr: null,
  measure_value: null,
  measure_unit: null,
  ...overrides,
});

const pay = (years: PayYear[]): PayVersusPerformance => ({
  cik: "0000829224",
  accession_number: "0001213900-26-007780",
  filing_date: "2026-01-26",
  measure_name: "Adjusted EPS",
  years,
});

const financials = (period_end: string, net_income: number): AnnualFinancials => ({
  fiscal_year: Number(period_end.slice(0, 4)),
  period_end,
  revenue: null,
  net_income,
  eps_diluted: null,
  operating_cash_flow: null,
  cash: null,
  total_assets: null,
  stockholders_equity: null,
});

describe("payRows", () => {
  it("gives each PEO of a year its own row and joins net income on period_end", () => {
    const rows = payRows(
      pay([
        year({
          period_end: "2024-09-29",
          executives: [
            { name: "Laxman Narasimhan", total_comp: 21_530_692, comp_actually_paid: 5_709_978 },
            { name: "Brian Niccol", total_comp: 95_801_676, comp_actually_paid: 96_434_632 },
          ],
        }),
      ]),
      [financials("2024-09-29", 3_760_900_000), financials("2023-10-01", 4_124_500_000)],
    );
    expect(rows.map((r) => [r.name, r.netIncome])).toEqual([
      ["Laxman Narasimhan", 3_760_900_000],
      ["Brian Niccol", 3_760_900_000],
    ]);
  });

  it("leaves net income null when no 10-K year ends on the same day", () => {
    const rows = payRows(
      pay([year({ executives: [{ name: null, total_comp: 1, comp_actually_paid: 2 }] })]),
      [financials("2025-09-28", 100)],
    );
    expect(rows[0].netIncome).toBeNull();
    expect(rows[0].name).toBeNull();
  });

  it("keeps a year with no executives as one row", () => {
    const rows = payRows(pay([year({})]), []);
    expect(rows).toHaveLength(1);
    expect(rows[0].totalComp).toBeNull();
    expect(rows[0].tsr).toBe(233.88);
  });
});

describe("formatMeasure", () => {
  it("formats by the tagged unit", () => {
    expect(formatMeasure(416_161_000_000, "USD")).toBe("$416.16B");
    expect(formatMeasure(3.35, "USD/share")).toBe("$3.35");
    expect(formatMeasure(2.15, "pure")).toBe("2.15");
    expect(formatMeasure(null, "USD")).toBe("—");
  });
});

describe("column visibility", () => {
  it("hides peer TSR and the measure when no year has them", () => {
    const small = pay([year({}), year({ period_end: "2024-12-31" })]);
    expect(hasPeerTsr(small)).toBe(false);
    expect(hasMeasure(small)).toBe(false);
    const large = pay([year({ peer_tsr: 279.51, measure_value: 2.15, measure_unit: "pure" })]);
    expect(hasPeerTsr(large)).toBe(true);
    expect(hasMeasure(large)).toBe(true);
  });
});

describe("sourceLine", () => {
  it("names the proxy's filing date", () => {
    expect(sourceLine(pay([]))).toBe(
      "From the pay-versus-performance table in the latest proxy filed Jan 26, 2026.",
    );
  });
});
