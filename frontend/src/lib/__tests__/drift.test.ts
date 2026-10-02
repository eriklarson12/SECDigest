import { describe, expect, it } from "vitest";
import { driftView } from "@/lib/drift";
import type { DriftResponse } from "@/lib/types";

function payload(overrides: Partial<DriftResponse> = {}): DriftResponse {
  return {
    state: "ok",
    prior_analysis_id: 2,
    prior_form_type: "10-Q",
    prior_filing_date: "2026-05-01",
    carried_over: 0.9634,
    mean_similarity: 0.959,
    novel_passages: [
      { chunk_index: 41, excerpt: "…component suppliers may fail…" },
    ],
    ...overrides,
  };
}

describe("driftView", () => {
  it("shows the share carried over, rounded down, and the passages", () => {
    const view = driftView(payload(), "10-Q");
    expect(view).toEqual({
      kind: "ready",
      priorDate: "May 1, 2026",
      priorLabel: "10-Q filed May 1, 2026",
      figure: "96%",
      passages: ["…component suppliers may fail…"],
    });
  });

  it("never rounds a filing with new text up to 100%", () => {
    const view = driftView(payload({ carried_over: 0.996 }), "10-Q");
    expect(view.kind === "ready" && view.figure).toBe("99%");
  });

  it("names the form it found no prior for", () => {
    const view = driftView(
      payload({ state: "no_prior", prior_form_type: null, carried_over: null }),
      "10-K",
    );
    expect(view).toEqual({
      kind: "note",
      text: "No earlier 10-K has been analyzed here to compare this filing's wording against.",
    });
  });

  it("names the prior filing while indexing is outstanding", () => {
    const view = driftView(
      payload({ state: "not_indexed", carried_over: null, novel_passages: [] }),
      "10-Q",
    );
    expect(view.kind).toBe("note");
    expect(view.kind === "note" && view.text).toContain(
      "10-Q filed May 1, 2026 once both filings finish indexing",
    );
  });
});
