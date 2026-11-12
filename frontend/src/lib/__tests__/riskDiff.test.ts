import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  similarity,
  diffRisks,
  hasSubstantiveRisks,
  findPriorAnalysis,
  SIMILARITY_THRESHOLD,
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
    expect(similarity(a, b)).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });

  it("keeps unrelated risks below the threshold", () => {
    const a =
      "New tariffs on imported components could increase product costs.";
    const b = "A cybersecurity breach could expose customer payment data.";
    expect(similarity(a, b)).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it("returns 0 when a sentence has no content words", () => {
    expect(similarity("the and for", "anything at all here")).toBe(0);
  });
});

// Real risk sentences from stored analyses, labelled by hand: same topic reworded, or two
// different risks. The distinct pairs are the closest ones in the corpus.
describe("similarity on stored filings", () => {
  const reworded: [string, string, string][] = [
    [
      "AAPL 10-K cybersecurity",
      "Cybersecurity incidents, information technology system failures, and unauthorized access to confidential personal data can harm the company's reputation, disrupt operations, and result in significant legal liabilities.",
      "Cybersecurity threats, network disruptions, or unauthorized breaches of sensitive customer data could lead to severe financial, operational, and reputational damage.",
    ],
    [
      "AMZN 10-Q security breaches",
      "System outages, network interruptions, or security breaches exposing sensitive data could result in severe operational disruption, reputational harm, and legal liability.",
      "Security breaches, cyberattacks, or data loss could disrupt operations, harm customer trust, and lead to significant legal liabilities.",
    ],
    [
      "AVGO 10-Q customer concentration",
      "High customer concentration leaves Broadcom vulnerable to order cancellations or financial instability among key clients, particularly in the AI sector.",
      "High customer concentration exposes the company to financial volatility if major customers reduce orders or change procurement strategies.",
    ],
    [
      "MU 10-Q gross margins",
      "Gross margins may be negatively impacted by manufacturing complexities, lower capacity utilization, technology transitions, and inflationary cost pressures.",
      "Gross margins may be harmed by capacity underutilization, rising input costs, product complexity, or misalignments between memory supply and demand.",
    ],
  ];
  for (const [name, current, prior] of reworded) {
    it(`pairs a reworded risk: ${name}`, () => {
      expect(similarity(current, prior)).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
    });
  }

  const distinct: [string, string, string][] = [
    [
      "NVDA 10-Q commitments vs data center constraints",
      "Substantial financial commitments, credit guarantees, and commercial lease arrangements for data center infrastructure expose the company to significant counterparty, execution, and credit risks.",
      "Constraints on data center availability, energy capacity, and customer capital could slow down AI infrastructure deployments.",
    ],
    [
      "GOOGL 10-Q breaches vs privacy law",
      "Cyberattacks, security breaches, and software vulnerabilities could lead to unauthorized data disclosure, system disruptions, substantial fines, and reputational damage.",
      "Compliance with complex and evolving global data privacy laws could lead to significant penalties and operational disruptions.",
    ],
    [
      "NVDA 10-Q data center constraints vs supply lead times",
      "Constraints on data center availability, energy capacity, and customer capital could slow down AI infrastructure deployments.",
      "Long manufacturing lead times and uncertain supply and capacity availability, combined with a failure to estimate customer demand accurately, has led and could lead to mismatches between supply and demand.",
    ],
  ];
  for (const [name, current, prior] of distinct) {
    it(`keeps distinct risks apart: ${name}`, () => {
      expect(similarity(current, prior)).toBeLessThan(SIMILARITY_THRESHOLD);
    });
  }

  it("matches a hyphenated word to its spaced form", () => {
    expect(similarity("single-source suppliers", "single source suppliers")).toBe(1);
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

  it("flags only the topic that changed in AAPL's 10-K (analysis 150 against 120)", () => {
    const current = [
      "Adverse macroeconomic conditions, inflation, tighter credit, and currency fluctuations can negatively impact consumer confidence and spending, reducing demand for the company's products and services.",
      "Global supply chain concentration and geopolitical tensions or trade restrictions, including tariffs, can disrupt manufacturing, increase component costs, and limit availability.",
      "The markets for the company's products and services are highly competitive, characterized by aggressive price competition, short product life cycles, and rapid technological advancements.",
      "The company depends heavily on single or limited sources for certain critical components and manufacturing services, exposing it to supply shortages and price volatility.",
      "Cybersecurity incidents, information technology system failures, and unauthorized access to confidential personal data can harm the company's reputation, disrupt operations, and result in significant legal liabilities.",
    ];
    const prior = [
      "Adverse global economic conditions, currency fluctuations, inflation, and international tariffs could significantly reduce consumer demand and increase operational costs.",
      "Reliance on third-party outsourcing partners and single-source component suppliers primarily located outside the U.S. exposes the company to supply chain disruptions and component shortages.",
      "Intense market competition and rapid technological innovation require continuous investment in R&D, with no guarantee of commercial success or maintaining competitive advantages.",
      "Global regulatory enforcement and litigation involving antitrust laws, intellectual property rights, data privacy, and digital platform rules could restrict operations and incur large monetary penalties.",
      "Cybersecurity threats, network disruptions, or unauthorized breaches of sensitive customer data could lead to severe financial, operational, and reputational damage.",
    ];
    const drift = diffRisks(current, prior);
    expect(drift.isNew).toEqual([false, true, false, false, false]);
    expect(drift.dropped).toEqual([prior[3]]);
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
    formType = "10-Q",
  ): AnalysisResponse {
    return {
      id,
      accession_number: accession,
      cik: "320193",
      ticker: "AAPL",
      company_name: "Apple Inc.",
      form_type: formType,
      filing_date: filingDate,
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

  it("skips a filing of another form", () => {
    const history = [current, analysis(2, "acc-2", "2026-02-01", "10-K")];
    expect(findPriorAnalysis(current, history)).toBeNull();
  });

  describe("agrees with the backend's pick_prior", () => {
    // The same file backend/tests/test_drift.py reads. A divergence means the risk diff and
    // the drift card compare against different filings on one page.
    const fixture = JSON.parse(
      readFileSync(
        path.resolve(__dirname, "../../../../backend/tests/fixtures/prior_analysis.json"),
        "utf8",
      ),
    ) as {
      history: { accession_number: string; form_type: string; filing_date: string | null }[];
      cases: { subject: string; prior: string | null; why: string }[];
    };
    const history = fixture.history.map((row, i) =>
      analysis(i + 1, row.accession_number, row.filing_date, row.form_type),
    );

    for (const c of fixture.cases) {
      it(c.why, () => {
        const subject = history.find((h) => h.accession_number === c.subject)!;
        expect(findPriorAnalysis(subject, history)?.accession_number ?? null).toBe(c.prior);
      });
    }
  });
});
