import { describe, expect, it } from "vitest";
import {
  parseFormParam,
  periodLabel,
  periodMismatch,
  pickComparePair,
} from "@/lib/comparePair";
import type { AnalysisResponse } from "@/lib/types";

let nextId = 1;
function analysis(
  ticker: string,
  form_type: string,
  filing_date: string | null,
): AnalysisResponse {
  return {
    id: nextId++,
    accession_number: `acc-${nextId}`,
    cik: "0",
    ticker,
    company_name: ticker,
    form_type,
    filing_date,
    revenue_current: null,
    revenue_yoy_change_pct: null,
    net_income_current: null,
    net_income_yoy_change_pct: null,
    risk_factors: [],
    management_guidance: null,
    summary: null,
    chunks_expected: null,
    sic: null,
    sic_description: null,
    owner_org: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

const aaplQ = analysis("AAPL", "10-Q", "2026-05-02");
const aaplK = analysis("AAPL", "10-K", "2025-10-31");
const aaplOldK = analysis("AAPL", "10-K", "2024-11-01");
const msftQ = analysis("MSFT", "10-Q", "2026-04-29");
const msftK = analysis("MSFT", "10-K", "2025-07-30");

describe("pickComparePair", () => {
  it("takes the newest 10-K on both sides when both have one", () => {
    // Listed oldest first: the API orders by creation, not filing date.
    const pair = pickComparePair([aaplOldK, aaplQ, aaplK], [msftQ, msftK]);
    expect(pair.a).toBe(aaplK);
    expect(pair.b).toBe(msftK);
    expect(pair.form).toBe("10-K");
    expect(pair.choices).toEqual(["10-K", "10-Q"]);
  });

  it("honours a quarterly preference both sides can meet", () => {
    const pair = pickComparePair([aaplQ, aaplK], [msftQ, msftK], "10-Q");
    expect(pair.a).toBe(aaplQ);
    expect(pair.b).toBe(msftQ);
    expect(pair.form).toBe("10-Q");
  });

  it("falls back to 10-Q on both when one side has no 10-K", () => {
    const pair = pickComparePair([aaplQ, aaplK], [msftQ]);
    expect(pair.a).toBe(aaplQ);
    expect(pair.b).toBe(msftQ);
    expect(pair.form).toBe("10-Q");
    expect(pair.choices).toEqual([]);
  });

  it("ignores a preference the pair cannot meet", () => {
    const pair = pickComparePair([aaplK], [msftK], "10-Q");
    expect(pair.form).toBe("10-K");
    expect(pair.a).toBe(aaplK);
  });

  it("shows each side's newest when no form is shared", () => {
    const pair = pickComparePair([aaplK, aaplOldK], [msftQ]);
    expect(pair.a).toBe(aaplK);
    expect(pair.b).toBe(msftQ);
    expect(pair.form).toBeNull();
    expect(pair.choices).toEqual([]);
  });

  it("gives a lone side its newest annual, so the second company does not move it", () => {
    const pair = pickComparePair([aaplQ, aaplK], []);
    expect(pair.a).toBe(aaplK);
    expect(pair.b).toBeNull();
    expect(pair.choices).toEqual([]);
  });

  it("returns nothing for two empty sides", () => {
    expect(pickComparePair([], [])).toEqual({
      a: null,
      b: null,
      form: "10-K",
      choices: [],
    });
  });

  it("counts an amendment as its parent form", () => {
    const amended = analysis("MSFT", "10-K/A", "2025-09-15");
    const pair = pickComparePair([aaplK], [msftK, amended]);
    expect(pair.b).toBe(amended);
  });

  it("ranks an undated analysis oldest", () => {
    const undated = analysis("AAPL", "10-K", null);
    expect(pickComparePair([undated, aaplK], []).a).toBe(aaplK);
  });
});

describe("periodMismatch", () => {
  it("names both periods when the forms differ", () => {
    expect(periodMismatch(aaplK, msftQ)).toBe(
      "AAPL's figures cover a fiscal year, MSFT's one quarter.",
    );
  });

  it("is null when the forms match", () => {
    expect(periodMismatch(aaplK, msftK)).toBeNull();
  });
});

describe("periodLabel and parseFormParam", () => {
  it("labels each family", () => {
    expect(periodLabel("10-K")).toBe("Fiscal year");
    expect(periodLabel("10-Q/A")).toBe("Quarter");
    expect(periodLabel("8-K")).toBeNull();
  });

  it("accepts only the two forms", () => {
    expect(parseFormParam("10-Q")).toBe("10-Q");
    expect(parseFormParam("10-K/A")).toBeNull();
    expect(parseFormParam(null)).toBeNull();
  });
});
