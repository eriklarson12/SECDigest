import { describe, expect, it } from "vitest";

import {
  MIN_POOL,
  benchmarkHref,
  poolCaption,
  similarState,
} from "@/lib/similar";
import type { SimilarFiling, SimilarFilingsResponse } from "@/lib/types";

function peer(overrides: Partial<SimilarFiling> = {}): SimilarFiling {
  return {
    analysis_id: 2,
    accession_number: "000000248842",
    ticker: "AMD",
    company_name: "Advanced Micro Devices Inc",
    form_type: "10-Q",
    filing_date: "2026-05-01",
    sic: "3674",
    sic_description: "Semiconductors & Related Devices",
    similarity: 0.9673,
    ...overrides,
  };
}

function response(
  overrides: Partial<SimilarFilingsResponse> = {},
): SimilarFilingsResponse {
  return { peers: [peer()], pool: 56, available: true, ...overrides };
}

describe("similarState", () => {
  it("is unavailable when the subject itself has no centroid", () => {
    // Never indexed, or indexed short. Distinct from having no peers.
    const state = similarState(response({ available: false, peers: [] }), "3571");
    expect(state.kind).toBe("unavailable");
  });

  it("prefers unavailable over too-small when both could apply", () => {
    const state = similarState(
      response({ available: false, peers: [], pool: 0 }),
      "3571",
    );
    expect(state.kind).toBe("unavailable");
  });

  it.each([0, 1, 2])("is too-small for a pool of %i", (pool) => {
    // A ranking drawn from one or two companies reads as a claim it cannot support.
    expect(similarState(response({ pool }), "3571").kind).toBe("too-small");
  });

  it("is too-small when the pool is large but no peers came back", () => {
    expect(similarState(response({ peers: [], pool: 56 }), "3571").kind).toBe(
      "too-small",
    );
  });

  it("is ready at the minimum pool size", () => {
    expect(similarState(response({ pool: MIN_POOL }), "3571").kind).toBe("ready");
  });

  it("maps a peer to a row, industry included", () => {
    const state = similarState(response(), "3571");
    if (state.kind !== "ready") throw new Error("expected ready");

    expect(state.rows[0]).toMatchObject({
      analysisId: 2,
      ticker: "AMD",
      companyName: "Advanced Micro Devices Inc",
      formType: "10-Q",
      industry: "SIC 3674 · Semiconductors & Related Devices",
    });
    expect(state.pool).toBe(56);
  });

  it("renders a code with no description as the code alone", () => {
    const state = similarState(
      response({ peers: [peer({ sic_description: null })] }),
      "3571",
    );
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.rows[0].industry).toBe("SIC 3674");
  });

  it("leaves industry null for an unclassified filer", () => {
    const state = similarState(
      response({ peers: [peer({ sic: null, sic_description: null })] }),
      "3571",
    );
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.rows[0].industry).toBeNull();
  });

  describe("differentIndustry", () => {
    function flagFor(subjectSic: string | null, peerSic: string | null) {
      const state = similarState(
        response({ peers: [peer({ sic: peerSic })] }),
        subjectSic,
      );
      if (state.kind !== "ready") throw new Error("expected ready");
      return state.rows[0].differentIndustry;
    }

    it("is true when both codes are known and differ", () => {
      expect(flagFor("3571", "3674")).toBe(true);
    });

    it("is false when the codes match", () => {
      expect(flagFor("3674", "3674")).toBe(false);
    });

    // A missing code is not evidence of a difference — the flag is a claim, not a default.
    it("is false when the peer is unclassified", () => {
      expect(flagFor("3571", null)).toBe(false);
    });

    it("is false when the subject is unclassified", () => {
      expect(flagFor(null, "3674")).toBe(false);
    });
  });
});

describe("poolCaption", () => {
  it("names the corpus the ranking drew from, not EDGAR", () => {
    expect(poolCaption(56)).toBe("Nearest of 56 other companies analyzed here");
  });

  it("says company, singular, for a pool of one", () => {
    expect(poolCaption(1)).toBe("Nearest of 1 other company analyzed here");
  });
});

describe("no similarity value is ever rendered", () => {
  // Cosine across this corpus spans roughly 0.80 to 0.99, so "97% similar" would read as a
  // strong match when it is close to average. A regression guard on that decision, not on
  // formatting: nothing the card builds may carry the number or a percent sign.
  it("keeps the score out of every string the card builds", () => {
    const state = similarState(response(), "3571");
    if (state.kind !== "ready") throw new Error("expected ready");

    const rendered = [
      poolCaption(state.pool),
      benchmarkHref("NVDA", state.rows),
      ...state.rows.flatMap((r) => [r.ticker, r.companyName, r.industry ?? ""]),
    ].join(" ");

    expect(rendered).not.toContain("%");
    expect(rendered).not.toContain("0.96");
    expect(Object.keys(state.rows[0])).not.toContain("similarity");
  });
});

describe("benchmarkHref", () => {
  it("uses ?only= so the set survives a full watchlist", () => {
    // ?add= is filtered against a watchlist seed that may already hold all ten rows, which
    // would show a different set than the button named.
    const href = benchmarkHref("NVDA", [
      { analysisId: 2, ticker: "AMD", companyName: "AMD", formType: "10-Q", industry: null, differentIndustry: false },
    ]);
    expect(href).toBe("/benchmark?only=NVDA,AMD");
  });

  it("puts the subject first", () => {
    const href = benchmarkHref("NVDA", [
      { analysisId: 2, ticker: "AMD", companyName: "AMD", formType: "10-Q", industry: null, differentIndustry: false },
      { analysisId: 3, ticker: "AVGO", companyName: "Broadcom", formType: "10-Q", industry: null, differentIndustry: false },
    ]);
    expect(href).toBe("/benchmark?only=NVDA,AMD,AVGO");
  });

  it("de-dupes and uppercases", () => {
    const href = benchmarkHref("nvda", [
      { analysisId: 2, ticker: "amd", companyName: "AMD", formType: "10-Q", industry: null, differentIndustry: false },
      { analysisId: 3, ticker: "NVDA", companyName: "Nvidia", formType: "10-K", industry: null, differentIndustry: false },
    ]);
    expect(href).toBe("/benchmark?only=NVDA,AMD");
  });
});
