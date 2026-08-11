import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getAnalysis, listAnalyses } from "@/lib/api";

function mockFetchStatus(status: number, body: unknown = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }))
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
      })
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

describe("listAnalyses", () => {
  it("sends limit/offset and the optional ticker filter", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ analyses: [], total: 0 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await listAnalyses(12, 0, "AAPL");
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("limit=12");
    expect(url).toContain("offset=0");
    expect(url).toContain("ticker=AAPL");
  });
});
