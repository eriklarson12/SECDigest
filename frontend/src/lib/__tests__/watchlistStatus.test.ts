import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWatchStatusCache,
  hasNewFiling,
  loadWatchStatus,
  type WatchStatus,
} from "@/lib/watchlistStatus";
import type { Filing, WatchItem } from "@/lib/types";

const { getFilings, listAnalyses } = vi.hoisted(() => ({
  getFilings: vi.fn(),
  listAnalyses: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ getFilings, listAnalyses }));

const AAPL: WatchItem = { ticker: "AAPL", cik: "320193", name: "Apple Inc." };
const MSFT: WatchItem = {
  ticker: "MSFT",
  cik: "789019",
  name: "Microsoft Corporation",
};

const FILING = {
  accession_number: "0000320193-26-000057",
  form_type: "10-Q",
  filing_date: "2026-05-02",
  primary_document: "aapl-q2.htm",
  primary_doc_description: "10-Q",
} satisfies Filing;

function analysis(filingDate: string | null) {
  return { analyses: [{ id: 1, filing_date: filingDate }], total: 1 };
}

beforeEach(() => {
  clearWatchStatusCache();
  getFilings.mockReset().mockResolvedValue([FILING]);
  listAnalyses.mockReset().mockResolvedValue(analysis("2026-05-02"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("request sharing (the /api/filings 30/min limit is the reason this exists)", () => {
  it("serves a second caller from cache without refetching", async () => {
    await loadWatchStatus(AAPL);
    await loadWatchStatus(AAPL);

    expect(getFilings).toHaveBeenCalledTimes(1);
    expect(listAnalyses).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight request between callers in the same tick", async () => {
    const [a, b] = await Promise.all([
      loadWatchStatus(AAPL),
      loadWatchStatus(AAPL),
    ]);

    expect(getFilings).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("keys by ticker, so a second company is fetched on its own", async () => {
    await loadWatchStatus(AAPL);
    await loadWatchStatus(MSFT);

    expect(getFilings).toHaveBeenCalledTimes(2);
  });

  it("refetches once the TTL has passed", async () => {
    vi.useFakeTimers();
    await loadWatchStatus(AAPL);
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    await loadWatchStatus(AAPL);

    expect(getFilings).toHaveBeenCalledTimes(2);
  });
});

describe("failures", () => {
  it("reports an error status when the filings lookup fails", async () => {
    getFilings.mockRejectedValueOnce(new Error("boom"));
    const status = await loadWatchStatus(AAPL);

    expect(status.status).toBe("error");
    expect(status.latestFiling).toBeNull();
    expect(status.analysisKnown).toBe(false);
  });

  it("evicts a failure instead of pinning it for the whole TTL", async () => {
    getFilings.mockRejectedValueOnce(new Error("boom"));
    await loadWatchStatus(AAPL);
    const retried = await loadWatchStatus(AAPL);

    expect(getFilings).toHaveBeenCalledTimes(2);
    expect(retried.status).toBe("ready");
  });

  it("still reports the filing when only the analysis lookup fails", async () => {
    listAnalyses.mockRejectedValueOnce(new Error("boom"));
    const status = await loadWatchStatus(AAPL);

    expect(status.status).toBe("ready");
    expect(status.latestFiling).toEqual(FILING);
    expect(status.latestAnalysis).toBeNull();
  });

  it("marks the analysis unknown when its lookup fails, so nothing reads that null as 'never analyzed'", async () => {
    listAnalyses.mockRejectedValueOnce(new Error("boom"));
    const status = await loadWatchStatus(AAPL);

    expect(status.analysisKnown).toBe(false);
    expect(hasNewFiling(status)).toBe(false);
  });

  it("evicts an analysis failure too, so the next surface retries", async () => {
    listAnalyses.mockRejectedValueOnce(new Error("boom"));
    await loadWatchStatus(AAPL);
    const retried = await loadWatchStatus(AAPL);

    expect(listAnalyses).toHaveBeenCalledTimes(2);
    expect(retried.analysisKnown).toBe(true);
  });
});

describe("hasNewFiling", () => {
  function ready(filing: string | null, stored: string | null): WatchStatus {
    return {
      item: AAPL,
      status: "ready",
      latestFiling: filing ? { ...FILING, filing_date: filing } : null,
      latestAnalysis: stored
        ? ({ filing_date: stored } as WatchStatus["latestAnalysis"])
        : null,
      analysisKnown: true,
    };
  }

  it("is true when EDGAR is ahead of the stored analysis", () => {
    expect(hasNewFiling(ready("2026-06-15", "2026-05-02"))).toBe(true);
  });

  it("is true when nothing has been analyzed yet", () => {
    expect(hasNewFiling(ready("2026-06-15", null))).toBe(true);
  });

  it("is false when the analysis is up to date", () => {
    expect(hasNewFiling(ready("2026-05-02", "2026-05-02"))).toBe(false);
  });

  it("is false when EDGAR returned nothing", () => {
    expect(hasNewFiling(ready(null, "2026-05-02"))).toBe(false);
  });

  it("is false for an errored lookup — a failed check is not a new filing", () => {
    expect(
      hasNewFiling({
        item: AAPL,
        status: "error",
        latestFiling: null,
        latestAnalysis: null,
        analysisKnown: false,
      }),
    ).toBe(false);
  });

  it("is false when the analysis is unknown, even with a filing in hand", () => {
    expect(
      hasNewFiling({ ...ready("2026-06-15", null), analysisKnown: false }),
    ).toBe(false);
  });
});
