import { describe, expect, it } from "vitest";
import {
  eventsBetween,
  headline,
  periodFor,
  revisionsBy,
} from "@/lib/changes";
import type {
  AnalysisResponse,
  AnnualFinancials,
  Filing,
  FinancialsResponse,
  Revision,
} from "@/lib/types";

function analysis(overrides: Partial<AnalysisResponse> = {}): AnalysisResponse {
  return {
    id: 1,
    accession_number: "NEW",
    cik: "320193",
    ticker: "AAPL",
    company_name: "Apple Inc.",
    form_type: "10-K",
    filing_date: "2025-10-31",
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
    created_at: "2025-11-01T00:00:00Z",
    ...overrides,
  };
}

function year(fiscal_year: number, period_end: string | null, base: number): AnnualFinancials {
  return {
    fiscal_year,
    period_end,
    revenue: base,
    net_income: base / 4,
    eps_diluted: base / 100,
    operating_cash_flow: base / 2,
    cash: null,
    total_assets: null,
    stockholders_equity: null,
  };
}

function financials(overrides: Partial<FinancialsResponse> = {}): FinancialsResponse {
  return {
    cik: "320193",
    years: [year(2024, "2024-09-28", 400), year(2025, "2025-09-27", 440)],
    quarters: [
      { period_end: "2026-03-28", revenue: 95, net_income: 24 },
      { period_end: "2026-06-27", revenue: 94, net_income: 23 },
    ],
    revisions: [],
    percentiles: [],
    ...overrides,
  };
}

function filing(form_type: string, filing_date: string): Filing {
  return {
    accession_number: `${form_type}-${filing_date}`,
    form_type,
    filing_date,
    primary_document: "doc.htm",
    primary_doc_description: null,
    items: [],
  };
}

describe("periodFor", () => {
  const rows = [
    { period_end: "2024-12-31" },
    { period_end: "2025-01-31" },
    { period_end: null },
  ];

  it("takes the latest period that ended inside the window", () => {
    expect(periodFor(rows, "2025-03-20")).toEqual({ period_end: "2025-01-31" });
  });

  it("ignores a period that ends after the filing", () => {
    expect(periodFor(rows, "2025-01-15")).toEqual({ period_end: "2024-12-31" });
  });

  it("counts the filing day itself but not 150 days back", () => {
    expect(periodFor([{ period_end: "2025-01-31" }], "2025-01-31")).not.toBeNull();
    expect(periodFor([{ period_end: "2025-01-01" }], "2025-05-31")).toBeNull();
  });

  it("finds nothing on a payload without period ends", () => {
    expect(periodFor([{ period_end: null }], "2025-03-01")).toBeNull();
  });
});

describe("headline", () => {
  const prior10k = analysis({ id: 2, accession_number: "OLD", filing_date: "2024-11-01" });

  it("compares four annual metrics for a 10-K pair", () => {
    const view = headline(analysis(), prior10k, financials());
    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") return;
    expect(view.priorLabel).toBe("FY2024");
    expect(view.currentLabel).toBe("FY2025");
    expect(view.annual).toBe(true);
    expect(view.rows.map((r) => r.label)).toEqual([
      "Revenue",
      "Net income",
      "Diluted EPS",
      "Operating cash flow",
    ]);
    expect(view.rows[0]).toMatchObject({ prior: 400, current: 440 });
    expect(view.rows[0].changePct).toBeCloseTo(10);
  });

  it("compares two quarterly metrics for a 10-Q pair", () => {
    const view = headline(
      analysis({ form_type: "10-Q", filing_date: "2026-07-31" }),
      analysis({ id: 2, form_type: "10-Q", filing_date: "2026-05-01" }),
      financials(),
    );
    expect(view.kind === "ready" && view.rows.map((r) => r.label)).toEqual([
      "Revenue",
      "Net income",
    ]);
    expect(view.kind === "ready" && view.currentLabel).toBe("Quarter ended Jun 27, 2026");
  });

  it("gives no percentage for a change off a loss", () => {
    const loss = { ...year(2024, "2024-09-28", 400), net_income: -10 };
    const view = headline(
      analysis(),
      prior10k,
      financials({ years: [loss, year(2025, "2025-09-27", 440)] }),
    );
    expect(view.kind === "ready" && view.rows[1].changePct).toBeNull();
  });

  it("is missing when one period has no row", () => {
    const view = headline(
      analysis(),
      prior10k,
      financials({ years: [year(2025, "2025-09-27", 440)] }),
    );
    expect(view).toEqual({ kind: "missing" });
  });

  it("is missing when the payload predates period_end", () => {
    const view = headline(
      analysis(),
      prior10k,
      financials({ years: [year(2024, null, 400), year(2025, null, 440)] }),
    );
    expect(view).toEqual({ kind: "missing" });
  });
});

describe("eventsBetween", () => {
  const rows = [
    filing("8-K", "2026-07-31"),
    filing("8-K/A", "2026-06-10"),
    filing("8-K", "2026-05-01"),
    filing("8-K", "2026-04-15"),
  ];

  it("keeps events after the prior filing and on or before this one", () => {
    const { events, truncated } = eventsBetween(rows, "2026-05-01", "2026-07-31", 100);
    expect(events.map((e) => e.filing_date)).toEqual(["2026-07-31", "2026-06-10"]);
    expect(truncated).toBe(false);
  });

  it("skips forms that are not events", () => {
    const { events } = eventsBetween(
      [filing("10-Q", "2026-06-01")],
      "2026-05-01",
      "2026-07-31",
      100,
    );
    expect(events).toEqual([]);
  });

  it("flags a scan that stopped inside the window", () => {
    const { truncated } = eventsBetween(rows.slice(0, 2), "2026-05-01", "2026-07-31", 2);
    expect(truncated).toBe(true);
  });
});

describe("revisionsBy", () => {
  it("keeps the revisions this filing made", () => {
    const revision = (latest_accn: string): Revision => ({
      fiscal_year: 2024,
      metric: "revenue",
      concept: "Revenues",
      first_val: 100,
      latest_val: 90,
      delta_pct: -10,
      first_accn: "FIRST",
      latest_accn,
    });
    expect(revisionsBy([revision("NEW"), revision("OTHER")], "NEW")).toEqual([
      revision("NEW"),
    ]);
  });

  it("matches XBRL's dashed accession to a stored dashless one", () => {
    const dashed = {
      fiscal_year: 2024,
      metric: "revenue",
      concept: "Revenues",
      first_val: 100,
      latest_val: 90,
      delta_pct: -10,
      first_accn: "0000320193-24-000123",
      latest_accn: "0000320193-25-000079",
    };
    expect(revisionsBy([dashed], "000032019325000079")).toEqual([dashed]);
  });
});
