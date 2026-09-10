"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { getSectorCounts, listAnalyses } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import {
  formatIndustry,
  formatSector,
  UNCLASSIFIED_SECTOR,
} from "@/lib/format";
import { withParam } from "@/lib/query";
import type {
  AnalysisResponse,
  SectorCount,
  SectorCountsResponse,
} from "@/lib/types";
import AnalysisHistory from "@/components/AnalysisHistory";
import Button from "@/components/Button";
import ErrorState from "@/components/ErrorState";
import SectorPicker from "@/components/SectorPicker";
import { SkeletonTableRows } from "@/components/Skeleton";

const PAGE_SIZE = 20;
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const SIC_RE = /^\d{1,4}$/;
// Review offices are free text ("06 Technology", "International Corp Fin"), so the only
// thing to check is the backend's own bound. Nothing read from here is ever rendered.
const OWNER_ORG_MAX = 64;

function HistoryContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Arrives from the industry line on an analysis or company page. A hand-edited
  // junk value degrades to the unfiltered page rather than a 422 from the backend.
  const rawSic = searchParams.get("sic");
  const sic = rawSic && SIC_RE.test(rawSic) ? rawSic : null;
  // From the sector line on the homepage (roadmap 8.5).
  const rawOwnerOrg = searchParams.get("owner_org");
  const ownerOrg =
    rawOwnerOrg && rawOwnerOrg.length <= OWNER_ORG_MAX ? rawOwnerOrg : null;

  const [analyses, setAnalyses] = useState<AnalysisResponse[]>([]);
  const [total, setTotal] = useState(0);
  // The description is carried by the rows, so a filter that matches nothing has none.
  // Remembering the last one seen keeps the label whole when a second filter empties the
  // page; it is stored with its code so a different one can never inherit it.
  const [sicLabel, setSicLabel] = useState<{
    code: string;
    description: string;
  } | null>(null);
  // Same rule for the sector: the office name is read off the rows and remembered with
  // the raw value it came from, never taken from the URL.
  const [sectorLabel, setSectorLabel] = useState<{
    raw: string;
    name: string;
  } | null>(null);
  const [sectors, setSectors] = useState<SectorCount[]>([]);
  // Issued once per mount and reused. The picker sits above the table, so resolving it
  // separately would push a painted table down; holding the promise lets every later
  // filter change await something already settled and still commit once.
  const sectorsRef = useRef<Promise<SectorCountsResponse | null> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterInput, setFilterInput] = useState("");
  const [filter, setFilter] = useState<string | undefined>(undefined);
  // The effect below fetches on a URL-filter change and must carry the ticker filter
  // with it; reading `filter` there would make the effect refire on every ticker change
  // too, which `commitFilter` already handles.
  const filterRef = useRef<string | undefined>(undefined);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchPage = useCallback(
    (
      tickerFilter: string | undefined,
      sicFilter: string | null,
      officeFilter: string | null,
    ) => {
      // The sectors call is caught inside the `all`, so a failing aggregate costs the
      // picker and never the rows.
      sectorsRef.current ??= getSectorCounts().catch(() => null);
      Promise.all([
        listAnalyses(
          PAGE_SIZE,
          0,
          tickerFilter,
          sicFilter ?? undefined,
          officeFilter ?? undefined,
        ),
        sectorsRef.current,
      ])
        .then(([res, counts]) => {
          setAnalyses(res.analyses);
          setTotal(res.total);
          setHasMore(res.analyses.length === PAGE_SIZE);
          if (counts) setSectors(counts.sectors);
          const description = res.analyses[0]?.sic_description;
          if (sicFilter && description)
            setSicLabel({ code: sicFilter, description });
          const office = res.analyses[0]?.owner_org;
          if (officeFilter && office)
            setSectorLabel({ raw: officeFilter, name: formatSector(office) });
        })
        .catch((e) =>
          setError(e instanceof Error ? e.message : "Failed to load history"),
        )
        .finally(() => setLoading(false));
    },
    [],
  );

  // Owns every param-driven fetch, including the first load. Handlers that change a URL
  // filter navigate and leave the fetch to this; handlers that only change the ticker
  // fetch directly. Splitting it that way is what keeps a clear from fetching twice.
  useEffect(() => {
    fetchPage(filterRef.current, sic, ownerOrg);
  }, [fetchPage, sic, ownerOrg]);

  // Cleanup only — the filter fetch itself is always triggered from an event handler.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function retry() {
    fetchPage(filter, sic, ownerOrg);
  }

  // Click-handler driven; errors never clear rows already on screen
  function loadMore() {
    setLoadingMore(true);
    setError(null);
    listAnalyses(
      PAGE_SIZE,
      analyses.length,
      filter,
      sic ?? undefined,
      ownerOrg ?? undefined,
    )
      .then((res) => {
        setAnalyses((prev) => [...prev, ...res.analyses]);
        setHasMore(res.analyses.length === PAGE_SIZE);
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load more"),
      )
      .finally(() => setLoadingMore(false));
  }

  function commitFilter(raw: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const upper = raw.trim().toUpperCase();
    const next = TICKER_RE.test(upper) ? upper : undefined;
    setFilter(next);
    filterRef.current = next;
    setLoading(true);
    setError(null);
    fetchPage(next, sic, ownerOrg);
  }

  function handleFilterChange(value: string) {
    setFilterInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => commitFilter(value), 300);
  }

  function handleFilterKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitFilter(filterInput);
    }
  }

  /** Drops one param and keeps the rest — with two URL filters, clearing either one by
   * navigating to a bare /history would silently clear the other as well. The picker
   * sets a param through the same helper, for the same reason. */
  function clearParam(key: string) {
    setLoading(true);
    setError(null);
    // The param change is the fetch trigger — a reload must not restore the filter.
    router.replace(withParam("/history", searchParams, key, null), {
      scroll: false,
    });
  }

  function clearAllFilters() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setFilterInput("");
    setFilter(undefined);
    filterRef.current = undefined;
    setLoading(true);
    setError(null);
    if (sic || ownerOrg) {
      router.replace("/history", { scroll: false });
    } else {
      fetchPage(undefined, null, null);
    }
  }

  // From the rows, never from the URL: the link carries only the code, and every stored
  // analysis of that code carries the same description.
  const industry = sic
    ? (formatIndustry(
        sic,
        sicLabel?.code === sic ? sicLabel.description : null,
      ) ?? undefined)
    : undefined;
  // The unclassified bucket has no row to read a name off — its rows are exactly the ones
  // with no office — so it renders the app's own constant rather than the URL's word.
  const sector = !ownerOrg
    ? undefined
    : ownerOrg === UNCLASSIFIED_SECTOR
      ? formatSector(null)
      : sectorLabel?.raw === ownerOrg
        ? sectorLabel.name
        : undefined;
  const filterLabel =
    [filter, industry, sector].filter(Boolean).join(" · ") || undefined;

  const clearButtonClass =
    "ml-1 cursor-pointer underline transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl text-text">Analysis History</h1>
        {!loading && analyses.length > 0 && (
          <Button icon={Download} onClick={() => downloadCsv(analyses)}>
            Export CSV
          </Button>
        )}
      </div>
      <div className="mb-4">
        <input
          type="text"
          value={filterInput}
          onChange={(e) => handleFilterChange(e.target.value)}
          onKeyDown={handleFilterKeyDown}
          placeholder="Filter by ticker…"
          aria-label="Filter history by ticker"
          className="h-11 w-full border-0 border-b border-text bg-transparent px-1 text-text placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:w-64"
        />
      </div>
      <SectorPicker sectors={sectors} active={ownerOrg} params={searchParams} />
      {(industry || sector || filter) && (
        <div className="mb-4 font-sans text-2xs text-muted">
          {industry && (
            <p data-testid="active-sic-filter">
              Filtered to {industry}{" "}
              <button
                onClick={() => clearParam("sic")}
                className={clearButtonClass}
              >
                Clear
              </button>
            </p>
          )}
          {sector && (
            <p data-testid="active-sector-filter">
              Filtered to {sector}{" "}
              <button
                onClick={() => clearParam("owner_org")}
                className={clearButtonClass}
              >
                Clear
              </button>
            </p>
          )}
          {!loading && (
            <p className="tabular-nums" data-testid="filter-count">
              {total} {total === 1 ? "analysis" : "analyses"}
            </p>
          )}
        </div>
      )}
      {loading ? (
        <SkeletonTableRows rows={6} />
      ) : error && analyses.length === 0 ? (
        <ErrorState message={error} onRetry={retry} inset="page" />
      ) : (
        <div>
          <AnalysisHistory
            analyses={analyses}
            filterLabel={filterLabel}
            onClearFilter={clearAllFilters}
          />
          {loadingMore && (
            <div className="mt-3">
              <SkeletonTableRows rows={3} />
            </div>
          )}
          {error && analyses.length > 0 && !loadingMore && (
            <ErrorState message={error} onRetry={loadMore} inset="inline" />
          )}
          {hasMore && !loadingMore && !error && (
            <div className="mt-6 text-center">
              <Button variant="secondary" onClick={loadMore}>
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// useSearchParams requires a Suspense boundary in the App Router
export default function HistoryPage() {
  return (
    <Suspense fallback={<SkeletonTableRows rows={6} />}>
      <HistoryContent />
    </Suspense>
  );
}
