import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  POLL_MS,
  publishIndexStatus,
  subscribeIndexStatus,
} from "@/lib/useIndexStatus";
import type { IndexStatus } from "@/lib/types";

const { getIndexStatus } = vi.hoisted(() => ({ getIndexStatus: vi.fn() }));

vi.mock("@/lib/api", () => ({ getIndexStatus }));

function status(
  state: IndexStatus["state"],
  chunks_indexed = 10,
): IndexStatus {
  return { state, chunks_indexed, chunks_total: 100 };
}

/** Lets the mocked fetch's promise callbacks run before the next assertion. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  getIndexStatus.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("subscribeIndexStatus", () => {
  it("polls once for a filing however many cards are watching it", async () => {
    // The reason this is a store and not a hook-local timer: the Ask card and the peers
    // section wait on the same transition, against a 60/minute endpoint.
    getIndexStatus.mockResolvedValue(status("complete"));
    const ask = vi.fn();
    const peers = vi.fn();

    const stopAsk = subscribeIndexStatus(1, ask);
    const stopPeers = subscribeIndexStatus(1, peers);
    await settle();

    expect(getIndexStatus).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(status("complete"));
    expect(peers).toHaveBeenCalledWith(status("complete"));

    stopAsk();
    stopPeers();
  });

  it("keeps polling while indexing runs and stops when it finishes", async () => {
    getIndexStatus
      .mockResolvedValueOnce(status("indexing", 24))
      .mockResolvedValueOnce(status("complete", 100));
    const listener = vi.fn();

    const stop = subscribeIndexStatus(2, listener);
    await settle();
    expect(listener).toHaveBeenLastCalledWith(status("indexing", 24));

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(listener).toHaveBeenLastCalledWith(status("complete", 100));

    // A settled index is a terminal answer — nothing may keep asking for it.
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(getIndexStatus).toHaveBeenCalledTimes(2);

    stop();
  });

  it("stops the chain when the last subscriber leaves", async () => {
    getIndexStatus.mockResolvedValue(status("indexing"));
    const stop = subscribeIndexStatus(3, vi.fn());
    await settle();

    stop();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    expect(getIndexStatus).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh poll after a re-subscribe, as Strict Mode forces", async () => {
    getIndexStatus.mockResolvedValue(status("complete"));
    subscribeIndexStatus(4, vi.fn())();
    await settle();

    const stop = subscribeIndexStatus(4, vi.fn());
    await settle();

    expect(getIndexStatus).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("publishIndexStatus", () => {
  it("hands a re-index result to every card and resumes polling from it", async () => {
    getIndexStatus.mockResolvedValue(status("unavailable", 0));
    const peers = vi.fn();
    const stop = subscribeIndexStatus(5, peers);
    await settle();

    getIndexStatus.mockResolvedValue(status("complete", 100));
    publishIndexStatus(5, status("indexing", 0));
    expect(peers).toHaveBeenLastCalledWith(status("indexing", 0));

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(peers).toHaveBeenLastCalledWith(status("complete", 100));

    stop();
  });

  it("does nothing for a filing nobody is watching", () => {
    publishIndexStatus(6, status("indexing"));
    expect(getIndexStatus).not.toHaveBeenCalled();
  });
});
