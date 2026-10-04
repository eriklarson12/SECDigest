import { describe, expect, it } from "vitest";

import {
  FLAG_SCAN_FORMS,
  eventFlags,
  flagLabel,
  latestTextFlags,
  mergeFlags,
  textFlags,
  withinWindow,
  type PanelFlag,
} from "@/lib/redflags";
import type { AnalysisResponse, Filing } from "@/lib/types";

const NOW = new Date("2026-10-03T12:00:00Z");

function filing(overrides: Partial<Filing> = {}): Filing {
  return {
    accession_number: "0001628280-26-000001",
    form_type: "8-K",
    filing_date: "2026-05-02",
    primary_document: "x.htm",
    primary_doc_description: null,
    items: [],
    ...overrides,
  };
}

function analysis(overrides: Partial<AnalysisResponse> = {}): AnalysisResponse {
  return {
    id: 1,
    accession_number: "000162828026048191",
    cik: "799850",
    ticker: "CRMT",
    company_name: "America's Car-Mart",
    form_type: "10-K",
    filing_date: "2026-07-14",
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
    created_at: "2026-07-15T00:00:00Z",
    ...overrides,
  };
}

const GOING_CONCERN = {
  kind: "going_concern" as const,
  filed_date: "2026-07-14",
  accession_number: "000162828026048191",
  form_type: "10-K",
  excerpt: "These conditions collectively raise substantial doubt.",
};

describe("eventFlags", () => {
  it("reads 4.01 and 4.02 off 8-Ks and amendments", () => {
    const flags = eventFlags(
      [
        filing({ items: ["4.01", "9.01"] }),
        filing({ accession_number: "a2", form_type: "8-K/A", items: ["4.02"] }),
        filing({ accession_number: "a3", items: ["2.02", "9.01"] }),
      ],
      NOW,
    );
    expect(flags.map((f) => f.kind)).toEqual(["auditor_change", "non_reliance"]);
    expect(flags[1].formType).toBe("8-K/A");
  });

  it("flags NT 10-K and NT 10-Q notices", () => {
    const flags = eventFlags(
      [filing({ form_type: "NT 10-K" }), filing({ accession_number: "b", form_type: "NT 10-Q" })],
      NOW,
    );
    expect(flags.map((f) => [f.kind, f.formType])).toEqual([
      ["late_filing", "NT 10-K"],
      ["late_filing", "NT 10-Q"],
    ]);
  });

  it("drops anything older than three years", () => {
    const flags = eventFlags(
      [
        filing({ filing_date: "2023-10-03", items: ["4.01"] }),
        filing({ accession_number: "old", filing_date: "2023-10-02", items: ["4.01"] }),
      ],
      NOW,
    );
    expect(flags.map((f) => f.date)).toEqual(["2023-10-03"]);
  });

  it("ignores periodic forms, even when an item list is present", () => {
    expect(eventFlags([filing({ form_type: "10-K", items: ["4.01"] })], NOW)).toEqual([]);
  });

  it("asks EDGAR for every form it reads, amendments by name", () => {
    expect([...FLAG_SCAN_FORMS]).toEqual(["8-K", "8-K/A", "NT 10-K", "NT 10-Q"]);
  });
});

describe("textFlags", () => {
  it("maps the wire shape and tolerates a backend without the field", () => {
    expect(textFlags(analysis({ flags: [GOING_CONCERN] }))).toEqual([
      {
        kind: "going_concern",
        date: "2026-07-14",
        accession: "000162828026048191",
        formType: "10-K",
        excerpt: GOING_CONCERN.excerpt,
      },
    ]);
    expect(textFlags(analysis())).toEqual([]);
    expect(textFlags(null)).toEqual([]);
  });
});

describe("latestTextFlags", () => {
  it("takes only the newest analyzed filing, so a cleared doubt stays cleared", () => {
    const older = analysis({ id: 1, filing_date: "2025-07-14", flags: [GOING_CONCERN] });
    const newer = analysis({ id: 2, filing_date: "2026-07-14", flags: [] });
    expect(latestTextFlags([older, newer], NOW)).toEqual([]);
    expect(latestTextFlags([newer, older], NOW)).toEqual([]);
  });

  it("applies the window to a stale newest filing", () => {
    const stale = analysis({
      filing_date: "2021-03-01",
      flags: [{ ...GOING_CONCERN, filed_date: "2021-03-01" }],
    });
    expect(latestTextFlags([stale], NOW)).toEqual([]);
  });
});

describe("mergeFlags", () => {
  const flag = (over: Partial<PanelFlag>): PanelFlag => ({
    kind: "auditor_change",
    date: "2026-01-01",
    accession: "0001628280-26-000001",
    formType: "8-K",
    ...over,
  });

  it("sorts newest first and keeps one row per filing and kind", () => {
    const merged = mergeFlags(
      [flag({ date: "2025-01-01", accession: "x" })],
      [flag({}), flag({ accession: "000162828026000001" })],
    );
    expect(merged.map((f) => f.date)).toEqual(["2026-01-01", "2025-01-01"]);
  });
});

describe("withinWindow", () => {
  it("drops a flag without a date rather than guessing its age", () => {
    expect(
      withinWindow([{ kind: "going_concern", date: null, accession: "a", formType: "10-K" }], NOW),
    ).toEqual([]);
  });
});

describe("flagLabel", () => {
  it("names which notice a late filing was", () => {
    expect(
      flagLabel({ kind: "late_filing", date: null, accession: "a", formType: "NT 10-Q" }),
    ).toBe("Late filing notice (NT 10-Q)");
  });
});
