"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FileSearch } from "lucide-react";
import SearchBar from "@/components/SearchBar";
import CompareColumn from "@/components/CompareColumn";
import EmptyState from "@/components/EmptyState";
import { SkeletonCard } from "@/components/Skeleton";
import { listAnalyses, searchCompanies } from "@/lib/api";
import type { AnalysisResponse, CompanySearchResult } from "@/lib/types";

interface Slot {
  company: CompanySearchResult | null;
  analysis: AnalysisResponse | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_SLOT: Slot = { company: null, analysis: null, loading: false, error: null };

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

function CompareContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [slots, setSlots] = useState<[Slot, Slot]>([EMPTY_SLOT, EMPTY_SLOT]);
  // URL state without stale-closure races when both sides resolve at once
  const tickersRef = useRef<[string | null, string | null]>([null, null]);

  function updateSlot(side: 0 | 1, patch: Partial<Slot>) {
    setSlots((prev) => {
      const next: [Slot, Slot] = [...prev];
      next[side] = { ...next[side], ...patch };
      return next;
    });
  }

  const loadAnalysis = useCallback((side: 0 | 1, company: CompanySearchResult) => {
    updateSlot(side, { company, analysis: null, loading: true, error: null });
    listAnalyses(1, 0, company.ticker)
      .then((res) =>
        updateSlot(side, { analysis: res.analyses[0] ?? null, loading: false })
      )
      .catch((e) =>
        updateSlot(side, {
          loading: false,
          error: e instanceof Error ? e.message : "Failed to load analysis",
        })
      );
  }, []);

  const syncUrl = useCallback(() => {
    const [a, b] = tickersRef.current;
    const params = new URLSearchParams();
    if (a) params.set("a", a);
    if (b) params.set("b", b);
    const qs = params.toString();
    // replace, not push — selections shouldn't spam browser history
    router.replace(qs ? `/compare?${qs}` : "/compare", { scroll: false });
  }, [router]);

  function handleSelect(side: 0 | 1, company: CompanySearchResult) {
    tickersRef.current[side] = company.ticker;
    syncUrl();
    loadAnalysis(side, company);
  }

  // Resolves ?a=&b= once on mount; unknown tickers degrade silently to empty pickers.
  // Fetches use the cancelled-flag pattern — never synchronous setState in the effect.
  useEffect(() => {
    let cancelled = false;

    ([0, 1] as const).forEach((side) => {
      const raw = searchParams.get(side === 0 ? "a" : "b");
      if (!raw) return;
      const ticker = raw.trim().toUpperCase();
      if (!TICKER_RE.test(ticker)) return;
      (async () => {
        try {
          const results = await searchCompanies(ticker);
          const match = results.find((c) => c.ticker.toUpperCase() === ticker);
          if (match && !cancelled) {
            tickersRef.current[side] = match.ticker;
            loadAnalysis(side, match);
          }
        } catch {
          // shared-link resolution is best-effort — leave the picker empty
        }
      })();
    });

    return () => {
      cancelled = true;
    };
  }, [searchParams, loadAnalysis]);

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-text">Compare Companies</h1>
      <p className="mb-6 text-sm text-muted">
        Pick two tickers to see their most recent analyses side by side. The URL
        updates as you pick, so a comparison can be shared or bookmarked.
      </p>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {([0, 1] as const).map((side) => {
          const slot = slots[side];
          return (
            <div key={side} className="min-w-0">
              <SearchBar onSelect={(company) => handleSelect(side, company)} />
              <div className="mt-4">
                {slot.loading ? (
                  <div className="space-y-4">
                    <SkeletonCard />
                    <SkeletonCard />
                  </div>
                ) : slot.error ? (
                  <div className="py-10 text-center">
                    <p role="alert" className="text-sm text-negative">
                      {slot.error}
                    </p>
                    <button
                      onClick={() => slot.company && handleSelect(side, slot.company)}
                      className="mt-4 h-11 cursor-pointer rounded-lg border border-border bg-surface px-5 text-sm font-medium text-text transition-colors duration-200 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      Retry
                    </button>
                  </div>
                ) : slot.company && !slot.analysis ? (
                  <EmptyState
                    icon={FileSearch}
                    title={`No analysis yet for ${slot.company.ticker}`}
                    message="Analyze one of its filings first, then come back to compare."
                    action={{ href: "/", label: "Analyze a filing" }}
                  />
                ) : slot.analysis ? (
                  <div className="animate-fade-in-up">
                    <CompareColumn analysis={slot.analysis} />
                  </div>
                ) : (
                  <p className="py-10 text-center text-sm text-muted">
                    Search a ticker to fill this side.
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// useSearchParams requires a Suspense boundary in the App Router
export default function ComparePage() {
  return (
    <Suspense
      fallback={
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      }
    >
      <CompareContent />
    </Suspense>
  );
}
