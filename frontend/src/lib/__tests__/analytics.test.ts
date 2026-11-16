import { afterEach, describe, expect, it, vi } from "vitest";
import { track } from "@/lib/analytics";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("track", () => {
  it("forwards the event and its data to the tracker", () => {
    const umami = { track: vi.fn() };
    vi.stubGlobal("window", { umami });
    track("watchlist_add", { ticker: "AAPL" });
    expect(umami.track).toHaveBeenCalledWith("watchlist_add", {
      ticker: "AAPL",
    });
  });

  it("sends an event with no data as a bare name", () => {
    const umami = { track: vi.fn() };
    vi.stubGlobal("window", { umami });
    track("ask_company");
    expect(umami.track).toHaveBeenCalledWith("ask_company", undefined);
  });

  it("drops the event when the tracker never loaded", () => {
    vi.stubGlobal("window", {});
    expect(() => track("ask_company")).not.toThrow();
  });

  it("does nothing during server rendering", () => {
    expect(() => track("ask_company")).not.toThrow();
  });

  it("swallows a tracker that throws", () => {
    vi.stubGlobal("window", {
      umami: {
        track: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(() => track("history_csv_export", { rows: 3 })).not.toThrow();
  });
});
