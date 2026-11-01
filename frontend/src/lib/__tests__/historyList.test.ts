import { describe, expect, it } from "vitest";
import {
  historyReducer,
  INITIAL_HISTORY,
  PAGE_SIZE,
  type HistoryList,
} from "@/lib/historyList";
import type { AnalysisResponse } from "@/lib/types";

function row(id: number, extra: Partial<AnalysisResponse> = {}) {
  return {
    id,
    ticker: `T${id}`,
    sic: "3571",
    sic_description: "Electronic Computers",
    owner_org: "06 Technology",
    ...extra,
  } as AnalysisResponse;
}

const rows = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => row(from + i));

const SECTORS = [{ owner_org: "06 Technology", count: 3 }];

function loaded(state: HistoryList, n: number, sic: string | null = null) {
  return historyReducer(state, {
    type: "pageLoaded",
    page: { analyses: rows(n), total: n + 5 },
    sectors: SECTORS,
    sic,
    ownerOrg: null,
  });
}

describe("historyReducer", () => {
  it("a loaded page replaces the rows and clears an earlier error", () => {
    const failed = historyReducer(INITIAL_HISTORY, {
      type: "pageFailed",
      message: "boom",
    });
    expect(failed).toMatchObject({ loading: false, error: "boom" });

    const next = loaded(failed, 3);
    expect(next.analyses).toHaveLength(3);
    expect(next).toMatchObject({
      total: 8,
      loading: false,
      error: null,
      hasMore: false,
    });
  });

  it("a full page means there may be more", () => {
    expect(loaded(INITIAL_HISTORY, PAGE_SIZE).hasMore).toBe(true);
  });

  it("keeps the last sectors when the aggregate failed", () => {
    const first = loaded(INITIAL_HISTORY, 2);
    const next = historyReducer(first, {
      type: "pageLoaded",
      page: { analyses: rows(1), total: 1 },
      sectors: null,
      sic: null,
      ownerOrg: null,
    });
    expect(next.sectors).toBe(SECTORS);
  });

  it("remembers an industry label through a filter that empties the page", () => {
    const labelled = loaded(INITIAL_HISTORY, 2, "3571");
    expect(labelled.sicLabel).toEqual({
      code: "3571",
      description: "Electronic Computers",
    });
    const empty = historyReducer(labelled, {
      type: "pageLoaded",
      page: { analyses: [], total: 0 },
      sectors: null,
      sic: "3571",
      ownerOrg: null,
    });
    expect(empty.sicLabel).toEqual(labelled.sicLabel);
  });

  it("names the sector from the rows, keyed on the raw param", () => {
    const next = historyReducer(INITIAL_HISTORY, {
      type: "pageLoaded",
      page: { analyses: rows(1), total: 1 },
      sectors: null,
      sic: null,
      ownerOrg: "06 Technology",
    });
    expect(next.sectorLabel?.raw).toBe("06 Technology");
    expect(next.sectorLabel?.name).toBeTruthy();
  });

  it("Load more appends and keeps the rows on failure", () => {
    const first = loaded(INITIAL_HISTORY, PAGE_SIZE);
    const started = historyReducer(first, { type: "moreStarted" });
    expect(started.loadingMore).toBe(true);

    const more = historyReducer(started, {
      type: "moreLoaded",
      analyses: rows(2, PAGE_SIZE + 1),
    });
    expect(more.analyses).toHaveLength(PAGE_SIZE + 2);
    expect(more).toMatchObject({ loadingMore: false, hasMore: false });

    const failed = historyReducer(started, {
      type: "moreFailed",
      message: "nope",
    });
    expect(failed.analyses).toHaveLength(PAGE_SIZE);
    expect(failed).toMatchObject({ loadingMore: false, error: "nope" });
  });

  it("a dropped Load more releases the spinner and touches nothing else", () => {
    const started = historyReducer(loaded(INITIAL_HISTORY, PAGE_SIZE), {
      type: "moreStarted",
    });
    const dropped = historyReducer(started, { type: "moreDropped" });
    expect(dropped).toEqual({ ...started, loadingMore: false });
  });

  it("reload shows the skeleton and clears the error", () => {
    const failed = historyReducer(INITIAL_HISTORY, {
      type: "pageFailed",
      message: "boom",
    });
    expect(historyReducer(failed, { type: "reload" })).toMatchObject({
      loading: true,
      error: null,
    });
  });
});
