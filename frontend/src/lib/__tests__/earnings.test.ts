import { describe, expect, it } from "vitest";
import {
  buttonLabel,
  isEarningsRelease,
  summaryByAccession,
  summaryFor,
} from "@/lib/earnings";
import type { EarningsSummary, Filing } from "@/lib/types";

const event = (overrides: Partial<Filing>): Filing => ({
  accession_number: "0000320193-26-000024",
  form_type: "8-K",
  filing_date: "2026-11-02",
  primary_document: "aapl-20261102.htm",
  primary_doc_description: null,
  items: ["2.02", "9.01"],
  ...overrides,
});

const summary: EarningsSummary = {
  accession_number: "000032019326000024",
  cik: "320193",
  document: "a8-kex991q4202609262026.htm",
  summary: "Revenue grew. EPS grew.",
  figures: [],
  model: "gemini-3.6-flash",
  created_at: "2026-11-04T12:00:00+00:00",
};

describe("isEarningsRelease", () => {
  it("is an original 8-K carrying item 2.02", () => {
    expect(isEarningsRelease(event({}))).toBe(true);
    expect(isEarningsRelease(event({ items: ["5.02"] }))).toBe(false);
    expect(isEarningsRelease(event({ form_type: "8-K/A" }))).toBe(false);
  });
});

describe("summaryFor", () => {
  it("matches the feed's dashed accession to the table's dashless one", () => {
    const stored = summaryByAccession([summary]);
    expect(summaryFor(stored, "0000320193-26-000024")).toBe(summary);
    expect(summaryFor(stored, "0000320193-26-000020")).toBeNull();
  });
});

describe("buttonLabel", () => {
  it("names each state in one line", () => {
    expect(buttonLabel({ pending: true, open: false, hasSummary: false })).toBe("Summarizing…");
    expect(buttonLabel({ pending: false, open: true, hasSummary: true })).toBe("Hide summary");
    expect(buttonLabel({ pending: false, open: false, hasSummary: true })).toBe("Show summary");
    expect(buttonLabel({ pending: false, open: false, hasSummary: false })).toBe("Summarize");
  });
});
