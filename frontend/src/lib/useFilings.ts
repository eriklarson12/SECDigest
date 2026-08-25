"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getFilings } from "./api";
import type { Filing } from "./types";

export type FormFilter = "all" | "10-K" | "10-Q";

/** Single source for the control's segments, the request param, and the empty-state
 * wording, so a new filter can't send one form type and name another. */
export const FORM_FILTERS = [
  { value: "all", label: "All", formType: "10-K,10-Q", noun: "10-K or 10-Q" },
  { value: "10-K", label: "10-K", formType: "10-K", noun: "10-K" },
  { value: "10-Q", label: "10-Q", formType: "10-Q", noun: "10-Q" },
] as const satisfies readonly {
  value: FormFilter;
  label: string;
  formType: string;
  noun: string;
}[];

export function formTypeFor(filter: FormFilter): string {
  return FORM_FILTERS.find((f) => f.value === filter)!.formType;
}

export function nounFor(filter: FormFilter): string {
  return FORM_FILTERS.find((f) => f.value === filter)!.noun;
}

type Status = "loading" | "ready" | "error";

/** A company's recent filings plus the form-type filter over them. Callers own the
 * heading and the control's placement; this hook owns fetching and filter state.
 * `cik` is null while a page is still resolving one — the hook idles until it isn't. */
export function useFilings(cik: string | null) {
  const [filter, setFilter] = useState<FormFilter>("all");
  const [filings, setFilings] = useState<Filing[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  // Toggling faster than the network means responses can land out of order; only
  // the newest request may write. The single-fetch call sites never needed this.
  const requestId = useRef(0);

  const load = useCallback(() => {
    if (!cik) return;
    const id = ++requestId.current;
    getFilings(cik, formTypeFor(filter))
      .then((data) => {
        if (id !== requestId.current) return;
        setFilings(data);
        setStatus("ready");
      })
      .catch((e) => {
        if (id !== requestId.current) return;
        setError(e instanceof Error ? e.message : "Failed to load filings");
        setStatus("error");
      });
  }, [cik, filter]);

  useEffect(() => {
    load();
  }, [load, retryTick]);

  function selectFilter(next: FormFilter) {
    if (next === filter) return;
    setStatus("loading");
    setError(null);
    setFilter(next);
  }

  function retry() {
    setStatus("loading");
    setError(null);
    setRetryTick((n) => n + 1);
  }

  return { filings, filter, selectFilter, status, error, retry };
}
