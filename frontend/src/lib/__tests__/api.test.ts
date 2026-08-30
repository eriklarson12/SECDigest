import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  askFiling,
  getAnalysis,
  getIndexStatus,
  listAnalyses,
  reindexFiling,
} from "@/lib/api";

function mockFetchStatus(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(headers),
      json: async () => body,
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("error mapping (users never see raw backend errors)", () => {
  it("maps 429 to rate-limit copy", async () => {
    mockFetchStatus(429);
    await expect(getAnalysis(1)).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining("Rate limit"),
    });
  });

  it("adds the countdown when a 429 carries Retry-After", async () => {
    mockFetchStatus(429, {}, { "Retry-After": "30" });
    await expect(getAnalysis(1)).rejects.toMatchObject({
      status: 429,
      message: "Rate limit reached — try again in 30s.",
    });
  });

  it("falls back to the generic wait when Retry-After is unusable", async () => {
    // An HTTP-date is legal in the header and deliberately not parsed
    mockFetchStatus(
      429,
      {},
      { "Retry-After": "Wed, 26 Aug 2026 12:00:00 GMT" },
    );
    await expect(getAnalysis(1)).rejects.toMatchObject({
      status: 429,
      message: "Rate limit reached — try again in a minute.",
    });
  });

  it("maps 502 to service-trouble copy", async () => {
    mockFetchStatus(502);
    await expect(getAnalysis(1)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("having trouble"),
    });
  });

  it("maps 503 to capacity copy", async () => {
    mockFetchStatus(503);
    await expect(getAnalysis(1)).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("capacity"),
    });
  });

  it("passes through a 422 detail string from the backend", async () => {
    mockFetchStatus(422, { detail: "Invalid ticker format" });
    await expect(getAnalysis(1)).rejects.toMatchObject({
      message: "Invalid ticker format",
    });
  });

  it("maps network failure to a connection message with status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(getAnalysis(1)).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("connection"),
    });
  });

  it("throws ApiError instances", async () => {
    mockFetchStatus(500);
    await expect(getAnalysis(1)).rejects.toBeInstanceOf(ApiError);
  });
});

describe("getIndexStatus", () => {
  it("returns the filing's Q&A coverage", async () => {
    mockFetchStatus(200, {
      state: "indexing",
      chunks_indexed: 24,
      chunks_total: 102,
    });
    await expect(getIndexStatus(1)).resolves.toEqual({
      state: "indexing",
      chunks_indexed: 24,
      chunks_total: 102,
    });
  });

  it("surfaces a 404 as an ApiError so the card can stay quiet", async () => {
    mockFetchStatus(404);
    await expect(getIndexStatus(999)).rejects.toBeInstanceOf(ApiError);
  });
});

describe("askFiling", () => {
  it("maps 404 to the Q&A-unavailable copy, not 'analysis not found'", async () => {
    mockFetchStatus(404, { detail: "Q&A isn't available for this filing" });
    await expect(askFiling(1, "What drove revenue?")).rejects.toMatchObject({
      status: 404,
      message: "Q&A isn't available for this filing.",
    });
  });

  it("maps 503 to the capacity copy", async () => {
    mockFetchStatus(503);
    await expect(askFiling(1, "What drove revenue?")).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("capacity"),
    });
  });

  it("POSTs the question to the ask endpoint", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => ({
        ok: true,
        status: 200,
        json: async () => ({
          answer: "Revenue grew.",
          sources: [],
          unit_scale: null,
        }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await askFiling(7, "What drove revenue?");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/analysis/7/ask");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      question: "What drove revenue?",
    });
    expect(result.answer).toBe("Revenue grew.");
  });
});

describe("listAnalyses", () => {
  it("sends limit/offset and the optional ticker filter", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => ({
        ok: true,
        status: 200,
        json: async () => ({ analyses: [], total: 0 }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listAnalyses(12, 0, "AAPL");
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("limit=12");
    expect(url).toContain("offset=0");
    expect(url).toContain("ticker=AAPL");
  });
});

describe("reindexFiling (repairing a short or missing index)", () => {
  it("POSTs to the filing's reindex endpoint", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          state: "indexing",
          chunks_indexed: 24,
          chunks_total: 80,
        }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(reindexFiling(1)).resolves.toMatchObject({
      state: "indexing",
      chunks_total: 80,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/analysis/1/reindex");
    expect(init?.method).toBe("POST");
  });

  it("surfaces the 503 the backend sends once the day's budget is spent", async () => {
    mockFetchStatus(503, {
      detail: "Daily indexing budget spent — this filing can be indexed tomorrow",
    });
    await expect(reindexFiling(1)).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("tomorrow"),
    });
  });
});
