"use client";

import { useEffect, useState } from "react";

export type SectionStatus = "loading" | "error" | "ready";

/** One page section that loads, fails and retries on its own. It idles while `key` is null.
 *
 * `load` MUST be stable (a module-level function): it is an effect dependency, so a new
 * function each render refetches each render. `empty` is the data before the first load and
 * after a failure; only its first value is read. State is set in promise callbacks only,
 * and a response for a superseded key is dropped. */
export function useSection<T>(
  key: string | null,
  load: (key: string) => Promise<T>,
  empty: T,
  fallbackError: string,
) {
  const [initial] = useState(empty);
  const [state, setState] = useState<{
    status: SectionStatus;
    data: T;
    error: string | null;
  }>({ status: "loading", data: initial, error: null });
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    load(key)
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data, error: null });
      })
      .catch((e) => {
        if (cancelled) return;
        setState({
          status: "error",
          data: initial,
          error: e instanceof Error ? e.message : fallbackError,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [key, load, initial, fallbackError, retryTick]);

  function retry() {
    setState((s) => ({ ...s, status: "loading", error: null }));
    setRetryTick((n) => n + 1);
  }

  return { ...state, retry };
}
