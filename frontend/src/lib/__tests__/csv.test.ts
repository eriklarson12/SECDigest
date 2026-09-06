import { describe, expect, it } from "vitest";
import { csvEscape, toCsv } from "@/lib/csv";
import type { AnalysisResponse } from "@/lib/types";

function analysis(overrides: Partial<AnalysisResponse> = {}): AnalysisResponse {
  return {
    id: 1,
    accession_number: "000032019325000057",
    cik: "320193",
    ticker: "AAPL",
    company_name: "Apple Inc.",
    form_type: "10-Q",
    filing_date: "2026-05-02",
    revenue_current: 1000000000,
    revenue_yoy_change_pct: 5.5,
    net_income_current: 200000000,
    net_income_yoy_change_pct: null,
    risk_factors: ["Supply chain risk.", "Regulatory risk."],
    management_guidance: "Growth expected.",
    summary: "A solid quarter.",
    sic: "3571",
    sic_description: "Electronic Computers",
    owner_org: "06 Technology",
    created_at: "2026-07-04T00:00:00+00:00",
    ...overrides,
  };
}

describe("csvEscape", () => {
  it("passes plain values through", () => {
    expect(csvEscape("AAPL")).toBe("AAPL");
    expect(csvEscape(42)).toBe("42");
  });

  it("quotes commas, quotes, and newlines", () => {
    expect(csvEscape("Apple, Inc.")).toBe('"Apple, Inc."');
    expect(csvEscape('He said "risk"')).toBe('"He said ""risk"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  it("renders null as empty", () => {
    expect(csvEscape(null)).toBe("");
  });
});

describe("toCsv", () => {
  it("produces a header plus one row per analysis", () => {
    const csv = toCsv([analysis(), analysis({ ticker: "MSFT" })]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(
      lines[0].startsWith(
        "ticker,company_name,sic,sic_description,owner_org,form_type",
      ),
    ).toBe(true);
    expect(lines[1]).toContain("AAPL");
    expect(lines[2]).toContain("MSFT");
  });

  it("joins risk factors and escapes fields containing commas", () => {
    const csv = toCsv([analysis({ company_name: "Apple, Inc." })]);
    expect(csv).toContain('"Apple, Inc."');
    expect(csv).toContain("Supply chain risk. | Regulatory risk.");
  });

  // The history page filters by SIC and by review office, so an export taken under
  // either filter has to say which one it was taken under.
  it("carries the SEC classification, office value unstripped", () => {
    const row = toCsv([analysis()]).trimEnd().split("\r\n")[1];
    expect(row).toContain("3571,Electronic Computers,06 Technology");
  });

  it("renders an unclassified filer as three empty cells", () => {
    const csv = toCsv([
      analysis({ sic: null, sic_description: null, owner_org: null }),
    ]);
    expect(csv.trimEnd().split("\r\n")[1]).toContain("Apple Inc.,,,,10-Q");
  });

  it("renders null metrics as empty cells", () => {
    const csv = toCsv([analysis({ revenue_current: null, summary: null })]);
    const row = csv.trimEnd().split("\r\n")[1];
    expect(row).toContain(",,"); // adjacent empty cells survive
  });
});
