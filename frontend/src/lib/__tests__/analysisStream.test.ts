import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createAnalysisStream } from "@/lib/api";
import type { AnalysisStage } from "@/lib/api";

const RESULT = { id: 7, ticker: "AAPL" };

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Serves the given chunks verbatim, so a test controls exactly where the network
 * would have split a frame. That boundary is the whole reason this parser exists
 * and is the one thing a Playwright `route.fulfill` mock cannot reproduce. */
function mockStream(chunks: string[], status = 200) {
  const encoder = new TextEncoder();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => ({}),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
    })),
  );
}

async function collect(chunks: string[], status?: number) {
  const stages: AnalysisStage[] = [];
  mockStream(chunks, status);
  const result = await createAnalysisStream(
    {} as never,
    (s) => void stages.push(s),
  );
  return { stages, result };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAnalysisStream", () => {
  it("reports every stage in order and returns the result", async () => {
    const { stages, result } = await collect([
      frame("stage", { stage: "cache_check" }),
      frame("stage", { stage: "fetching_filing" }),
      frame("stage", { stage: "extracting" }),
      frame("stage", { stage: "storing" }),
      frame("result", RESULT),
    ]);
    expect(stages).toEqual([
      "cache_check",
      "fetching_filing",
      "extracting",
      "storing",
    ]);
    expect(result).toEqual(RESULT);
  });

  it("reassembles a frame split across chunks", async () => {
    const whole = frame("stage", { stage: "extracting" }) + frame("result", RESULT);
    const cut = whole.indexOf("extracting") + 3;
    const { stages, result } = await collect([whole.slice(0, cut), whole.slice(cut)]);
    expect(stages).toEqual(["extracting"]);
    expect(result).toEqual(RESULT);
  });

  it("reads several frames delivered in one chunk", async () => {
    const { stages } = await collect([
      frame("stage", { stage: "cache_check" }) +
        frame("stage", { stage: "storing" }) +
        frame("result", RESULT),
    ]);
    expect(stages).toEqual(["cache_check", "storing"]);
  });

  it("ignores keepalive comments", async () => {
    const { stages, result } = await collect([
      ": keepalive\n\n",
      frame("stage", { stage: "extracting" }),
      ": keepalive\n\n",
      frame("result", RESULT),
    ]);
    expect(stages).toEqual(["extracting"]);
    expect(result).toEqual(RESULT);
  });

  it("accepts CRLF line endings", async () => {
    const { stages } = await collect([
      'event: stage\r\ndata: {"stage":"storing"}\r\n\r\n',
      frame("result", RESULT),
    ]);
    expect(stages).toEqual(["storing"]);
  });

  it("maps an error frame to the same copy the JSON path shows", async () => {
    mockStream([
      frame("stage", { stage: "extracting" }),
      frame("error", { status: 503, detail: "at capacity" }),
    ]);
    await expect(createAnalysisStream({} as never, () => {})).rejects.toMatchObject({
      status: 503,
      message: "Analysis service is at capacity — try again in a minute.",
    });
  });

  it("treats a stream that ends without a result as a transport failure", async () => {
    mockStream([frame("stage", { stage: "extracting" })]);
    // status 0 is what useAnalyze keys its one non-streaming retry on
    await expect(
      createAnalysisStream({} as never, () => {}),
    ).rejects.toMatchObject({ status: 0 });
  });

  it("never surfaces a parse error as the user-facing message", async () => {
    mockStream(["event: result\ndata: {not json}\n\n"]);
    const error = await createAnalysisStream({} as never, () => {}).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe("Analysis was interrupted — try again.");
  });

  it("maps a rejection that lands before the stream opens", async () => {
    mockStream([], 429);
    await expect(
      createAnalysisStream({} as never, () => {}),
    ).rejects.toMatchObject({
      status: 429,
      message: "Rate limit reached — try again in a minute.",
    });
  });
});
