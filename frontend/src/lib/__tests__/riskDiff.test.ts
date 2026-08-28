import { describe, expect, it } from "vitest";
import {
  similarity,
  diffRisks,
  hasSubstantiveRisks,
  findPriorAnalysis,
} from "@/lib/riskDiff";
import type { AnalysisResponse } from "@/lib/types";

describe("similarity", () => {
  it("is 1 for identical sentences", () => {
    const s =
      "Dependence on a small number of outsourcing partners for manufacturing.";
    expect(similarity(s, s)).toBe(1);
  });

  it("pairs paraphrases of the same risk above the threshold", () => {
    const a =
      "The company depends heavily on outsourcing partners in Asia for manufacturing.";
    const b = "Heavy dependence on Asian manufacturing outsourcing partners.";
    expect(similarity(a, b)).toBeGreaterThanOrEqual(0.25);
  });

  it("keeps unrelated risks below the threshold", () => {
    const a =
      "New tariffs on imported components could increase product costs.";
    const b = "A cybersecurity breach could expose customer payment data.";
    expect(similarity(a, b)).toBeLessThan(0.25);
  });

  it("returns 0 when a sentence has no content words", () => {
    expect(similarity("the and for", "anything at all here")).toBe(0);
  });
});

describe("diffRisks", () => {
  const prior = [
    "Dependence on outsourcing partners in Asia for product manufacturing.",
    "Intense competition could pressure prices and margins.",
  ];

  it("flags risks with no prior counterpart as new", () => {
    const current = [
      "Heavy dependence on Asian manufacturing outsourcing partners.",
      "New tariffs on imported components could increase costs significantly.",
    ];
    const drift = diffRisks(current, prior);
    expect(drift.isNew).toEqual([false, true]);
  });

  it("reports prior risks missing from the current list as dropped", () => {
    const current = [
      "Heavy dependence on Asian manufacturing outsourcing partners.",
    ];
    const drift = diffRisks(current, prior);
    expect(drift.dropped).toEqual([
      "Intense competition could pressure prices and margins.",
    ]);
  });
});

describe("hasSubstantiveRisks", () => {
  it("rejects empty lists and the no-material-changes sentinel", () => {
    expect(hasSubstantiveRisks([])).toBe(false);
    expect(
      hasSubstantiveRisks([
        "Company reported no material changes to previously disclosed risk factors.",
      ]),
    ).toBe(false);
    expect(hasSubstantiveRisks(["Supply chain risk."])).toBe(true);
  });
});

describe("findPriorAnalysis", () => {
  function analysis(
    id: number,
    accession: string,
    filingDate: string | null,
  ): AnalysisResponse {
    return {
      id,
      accession_number: accession,
      cik: "320193",
      ticker: "AAPL",
      company_name: "Apple Inc.",
      form_type: "10-Q",
      filing_date: filingDate,
      revenue_current: null,
      revenue_yoy_change_pct: null,
      net_income_current: null,
      net_income_yoy_change_pct: null,
      risk_factors: [],
      management_guidance: null,
      summary: null,
      created_at: "2026-07-04T00:00:00+00:00",
    };
  }

  const current = analysis(3, "acc-3", "2026-05-02");

  it("picks the most recent strictly earlier filing", () => {
    const history = [
      current,
      analysis(2, "acc-2", "2026-02-01"),
      analysis(1, "acc-1", "2025-11-01"),
    ];
    expect(findPriorAnalysis(current, history)?.id).toBe(2);
  });

  it("skips itself, later filings, and undated rows", () => {
    const history = [
      current,
      analysis(4, "acc-4", "2026-08-01"),
      analysis(5, "acc-5", null),
    ];
    expect(findPriorAnalysis(current, history)).toBeNull();
  });

  it("returns null when the current analysis has no filing date", () => {
    const undated = analysis(9, "acc-9", null);
    expect(
      findPriorAnalysis(undated, [analysis(1, "acc-1", "2025-11-01")]),
    ).toBeNull();
  });
});
