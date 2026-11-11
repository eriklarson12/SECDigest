"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FileSearch } from "lucide-react";
import SearchBar from "@/components/SearchBar";
import SegmentedControl from "@/components/SegmentedControl";
import CompareColumn from "@/components/CompareColumn";
import CompareTrendChart from "@/components/CompareTrendChart";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
import { SkeletonCompareColumn } from "@/components/Skeleton";
import { getFinancials, listAnalyses } from "@/lib/api";
import { findCompany } from "@/lib/companyLookup";
import { buildAnnualPoints } from "@/lib/financials";
import {
  COMPARE_HISTORY,
  parseFormParam,
  periodMismatch,
  pickComparePair,
  type PeriodForm,
} from "@/lib/comparePair";
import type {
  AnalysisResponse,
  CompanySearchResult,
  TrendPoint,
} from "@/lib/types";
import { TICKER_RE } from "@/lib/ticker";

interface Slot {
  company: CompanySearchResult | null;
  /** Up to `COMPARE_HISTORY` stored analyses; null until they load, or on failure. */
  analyses: AnalysisResponse[] | null;
  loading: boolean;
  error: string | null;
  /** Annual XBRL series for the overlay chart; empty until it loads, or on failure. */
  points: TrendPoint[];
}

const PERIOD_OPTIONS = [
  { value: "10-K", label: "Annual" },
  { value: "10-Q", label: "Quarterly" },
] as const;

const EMPTY_SLOT: Slot = {
  company: null,
  analyses: null,
  loading: false,
  error: null,
  points: [],
};

function CompareContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Read once: every pick rewrites the URL, and re-resolving on that would refetch both sides.
  const [initial] = useState(() => ({
    a: searchParams.get("a"),
    b: searchParams.get("b"),
    form: parseFormParam(searchParams.get("form")),
  }));
  const [slots, setSlots] = useState<[Slot, Slot]>([EMPTY_SLOT, EMPTY_SLOT]);
  const [preferred, setPreferred] = useState<PeriodForm | null>(initial.form);
  // URL state without stale-closure races when both sides resolve at once
  const tickersRef = useRef<[string | null, string | null]>([null, null]);
  const formRef = useRef<PeriodForm | null>(initial.form);

  function updateSlot(side: 0 | 1, patch: Partial<Slot>) {
    setSlots((prev) => {
      const next: [Slot, Slot] = [...prev];
      next[side] = { ...next[side], ...patch };
      return next;
    });
  }

  const loadAnalysis = useCallback(
    (side: 0 | 1, company: CompanySearchResult) => {
      updateSlot(side, {
        company,
        analyses: null,
        loading: true,
        error: null,
        points: [],
      });
      listAnalyses(COMPARE_HISTORY, 0, company.ticker)
        .then((res) =>
          updateSlot(side, { analyses: res.analyses, loading: false }),
        )
        .catch((e) =>
          updateSlot(side, {
            loading: false,
            error: e instanceof Error ? e.message : "Failed to load analysis",
          }),
        );
      // Independent of the analysis fetch: the snapshot column must not wait on XBRL,
      // and a company with no stored analysis still has a series worth charting.
      getFinancials(company.cik)
        .then((data) =>
          updateSlot(side, { points: buildAnnualPoints(data.years) }),
        )
        .catch(() => {
          // Best-effort: one side failing just drops the overlay.
        });
    },
    [],
  );

  const syncUrl = useCallback(() => {
    const [a, b] = tickersRef.current;
    const params = new URLSearchParams();
    if (a) params.set("a", a);
    if (b) params.set("b", b);
    if (formRef.current) params.set("form", formRef.current);
    const qs = params.toString();
    // replace, not push — selections shouldn't spam browser history
    router.replace(qs ? `/compare?${qs}` : "/compare", { scroll: false });
  }, [router]);

  function handleSelect(side: 0 | 1, company: CompanySearchResult) {
    tickersRef.current[side] = company.ticker;
    syncUrl();
    loadAnalysis(side, company);
  }

  function handleFormChange(form: PeriodForm) {
    formRef.current = form;
    setPreferred(form);
    syncUrl();
  }

  // Resolves ?a=&b= once on mount; unknown tickers degrade silently to empty pickers.
  // Fetches use the cancelled-flag pattern — never synchronous setState in the effect.
  useEffect(() => {
    let cancelled = false;

    ([0, 1] as const).forEach((side) => {
      const raw = side === 0 ? initial.a : initial.b;
      if (!raw) return;
      const ticker = raw.trim().toUpperCase();
      if (!TICKER_RE.test(ticker)) return;
      // Best-effort: an unresolvable shared link leaves the picker empty.
      findCompany(ticker).then((match) => {
        if (match && !cancelled) {
          tickersRef.current[side] = match.ticker;
          loadAnalysis(side, match);
        }
      });
    });

    return () => {
      cancelled = true;
    };
  }, [initial, loadAnalysis]);

  const pair = pickComparePair(
    slots[0].analyses ?? [],
    slots[1].analyses ?? [],
    preferred,
  );
  const picked = [pair.a, pair.b] as const;
  const mismatch = pair.a && pair.b ? periodMismatch(pair.a, pair.b) : null;

  return (
    <div>
      <h1 className="mb-2 text-2xl text-text">Compare Companies</h1>
      <p className="mb-6 text-sm text-muted">
        Pick two tickers to see their latest analyses side by side, annual beside
        annual where both have one. The URL updates as you pick, so a comparison
        can be shared or bookmarked.
      </p>

      {/* Both pickers come before both columns, so at 375px the second is not below the
          first company's whole summary. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-6">
        {([0, 1] as const).map((side) => (
          <SearchBar
            key={side}
            selected={slots[side].company}
            onSelect={(company) => handleSelect(side, company)}
          />
        ))}
      </div>

      {/* Reserved from the second pick, so a side landing late fills it rather than
          pushing the columns down. */}
      {slots[0].company && slots[1].company && (
        <div className="mt-2 flex min-h-11 items-center">
          {pair.choices.length > 0 && pair.form ? (
            <SegmentedControl
              label="Period"
              options={PERIOD_OPTIONS}
              value={pair.form}
              onChange={handleFormChange}
            />
          ) : mismatch ? (
            <p className="font-sans text-xs text-muted">{mismatch}</p>
          ) : null}
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
        {([0, 1] as const).map((side) => {
          const slot = slots[side];
          const analysis = picked[side];
          return (
            <div key={side} className="min-w-0">
              {slot.loading ? (
                <SkeletonCompareColumn side={side} />
              ) : slot.error ? (
                <ErrorState
                  message={slot.error}
                  onRetry={() =>
                    slot.company && handleSelect(side, slot.company)
                  }
                />
              ) : slot.company && !analysis ? (
                <EmptyState
                  icon={FileSearch}
                  title={`No analysis yet for ${slot.company.ticker}`}
                  message="Analyze one of its filings first, then come back to compare."
                  action={{ href: "/", label: "Analyze a filing" }}
                />
              ) : analysis ? (
                <CompareColumn analysis={analysis} side={side} />
              ) : null}
            </div>
          );
        })}
      </div>

      {slots[0].company && slots[1].company && (
        <CompareTrendChart
          aTicker={slots[0].company.ticker}
          bTicker={slots[1].company.ticker}
          aPoints={slots[0].points}
          bPoints={slots[1].points}
        />
      )}
    </div>
  );
}

// useSearchParams requires a Suspense boundary in the App Router
export default function ComparePage() {
  return (
    <Suspense
      fallback={
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <SkeletonCompareColumn side={0} />
          <SkeletonCompareColumn side={1} />
        </div>
      }
    >
      <CompareContent />
    </Suspense>
  );
}
