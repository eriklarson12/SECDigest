"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getIndexStatus } from "./api";
import type { IndexStatus } from "./types";

/** Full indexing takes minutes against the free-tier embedding cap, so coverage ramps up
 * after an analysis; polling surfaces that (an earlier-indexed filing settles on the first poll). */
export const POLL_MS = 5000;

interface Poll {
  listeners: Set<(status: IndexStatus) => void>;
  /** Bumped whenever a chain is replaced, so a response already in flight cannot schedule a
   * second timer beside the new one. */
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** One poll per filing, not per subscriber. The Ask card and the peers section both wait on
 * the same transition out of "indexing", and two chained timeouts against a 60/minute
 * endpoint is duplication, not redundancy. */
const polls = new Map<number, Poll>();

/** Chained timeout, never an interval: a slow response must not stack requests. */
function tick(analysisId: number, generation: number): void {
  getIndexStatus(analysisId)
    .then((status) => {
      const poll = polls.get(analysisId);
      if (!poll || poll.generation !== generation) return;
      poll.listeners.forEach((listener) => listener(status));
      if (status.state === "indexing") {
        poll.timer = setTimeout(() => tick(analysisId, generation), POLL_MS);
      }
    })
    .catch(() => {
      // Coverage is advisory — a failed poll leaves both cards on what they already show
      // rather than putting an error on cards that still work.
    });
}

/** Publishes a status the caller already holds (POST /reindex returns one) and resumes
 * polling from it, so a re-index started on the Ask card also refreshes the peers section. */
export function publishIndexStatus(
  analysisId: number,
  status: IndexStatus,
): void {
  const poll = polls.get(analysisId);
  if (!poll) return;
  clearTimeout(poll.timer);
  poll.generation += 1;
  const generation = poll.generation;
  poll.listeners.forEach((listener) => listener(status));
  if (status.state === "indexing") {
    poll.timer = setTimeout(() => tick(analysisId, generation), POLL_MS);
  }
}

export function subscribeIndexStatus(
  analysisId: number,
  listener: (status: IndexStatus) => void,
): () => void {
  let poll = polls.get(analysisId);
  const first = !poll;
  if (!poll) {
    poll = { listeners: new Set(), generation: 0 };
    polls.set(analysisId, poll);
  }
  poll.listeners.add(listener);
  if (first) tick(analysisId, poll.generation);

  return () => {
    const current = polls.get(analysisId);
    if (!current) return;
    current.listeners.delete(listener);
    // Subscribe and unsubscribe must stay symmetric: Strict Mode runs effect -> cleanup ->
    // effect, and an entry outliving its last listener would poll a filing nobody is reading.
    if (current.listeners.size === 0) {
      clearTimeout(current.timer);
      polls.delete(analysisId);
    }
  };
}

export interface IndexStatusHandle {
  /** Null until the first poll answers. */
  status: IndexStatus | null;
  /** Increments each time indexing finishes while this component is mounted — never on a
   * filing that was already indexed at mount. A refetch keyed on it costs one request at the
   * moment the answer changes, where `status` alone would spend one on every page view. */
  completions: number;
  /** Hands the store a status the caller already has, and resumes polling from it. */
  publish: (status: IndexStatus) => void;
}

/** Q&A coverage for one filing, refreshed until indexing stops. */
export function useIndexStatus(analysisId: number): IndexStatusHandle {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [completions, setCompletions] = useState(0);
  const wasIndexing = useRef(false);

  useEffect(() => {
    let cancelled = false;
    wasIndexing.current = false;

    // setState happens only in the subscription callback, never in the effect body
    // (eslint set-state-in-effect).
    const unsubscribe = subscribeIndexStatus(analysisId, (next) => {
      if (cancelled) return;
      setStatus(next);
      if (wasIndexing.current && next.state !== "indexing") {
        setCompletions((n) => n + 1);
      }
      wasIndexing.current = next.state === "indexing";
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [analysisId]);

  return {
    status,
    completions,
    publish: useCallback(
      (next: IndexStatus) => publishIndexStatus(analysisId, next),
      [analysisId],
    ),
  };
}
