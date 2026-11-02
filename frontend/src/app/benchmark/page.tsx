"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Scale } from "lucide-react";
import SearchBar from "@/components/SearchBar";
import BenchmarkTable from "@/components/BenchmarkTable";
import EmptyState from "@/components/EmptyState";
import { SkeletonTableRows } from "@/components/Skeleton";
import { getFinancials } from "@/lib/api";
import { MAX_ROWS, parseTickers, resolveSeed } from "@/lib/benchmarkSeed";
import { findCompany } from "@/lib/companyLookup";
import {
  buildBenchmarkRow,
  sortBenchmarkRows,
  type BenchmarkRow,
  type SortDir,
  type SortKey,
} from "@/lib/ratios";
import { getWatchlist } from "@/lib/watchlist";
import type { CompanySearchResult, WatchItem } from "@/lib/types";

function loadingRow(item: WatchItem): BenchmarkRow {
  return {
    item,
    state: "loading",
    fiscalYear: null,
    revenue: null,
    netMargin: null,
    ocfMargin: null,
    grossMargin: null,
    operatingMargin: null,
    fcfMargin: null,
    liabilitiesToEquity: null,
    currentRatio: null,
    revenueCagr: null,
    revenuePercentile: null,
  };
}

function BenchmarkContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Captured once: adding a company rewrites the URL, and a live read would
  // re-run the seeding effect on every add.
  const [initialAdd] = useState(() => searchParams.get("add") ?? "");
  // The company whose industry seeds the table, from the "Compare to peers" button.
  // A ticker rather than a SIC: the peers endpoint is keyed on a company, and it is the
  // subject that guarantees itself a row in a list its own industry feed can omit.
  const [initialPeers] = useState(() =>
    (searchParams.get("peers") ?? "").trim().toUpperCase(),
  );
  // Distinct from `?add=` because it *replaces* the watchlist rather than layering on it:
  // `?add=` is filtered against a watchlist seed that has already taken all ten rows, so a
  // user with a full watchlist would see none of the set the button named.
  const [initialOnly] = useState(() => searchParams.get("only") ?? "");
  const [rows, setRows] = useState<BenchmarkRow[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  // Provenance for the caption, set only when a peer seed actually resolved.
  const [industry, setIndustry] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "netMargin",
    dir: "desc",
  });
  // Two refs, both because setRows' updater is not guaranteed to run before the
  // next statement: `tickersRef` is what dedupes and enforces MAX_ROWS,
  // `addedRef` is the ad-hoc half that goes back into the URL.
  const tickersRef = useRef<string[]>([]);
  const addedRef = useRef<string[]>([]);

  const fetchRow = useCallback((item: WatchItem) => {
    getFinancials(item.cik)
      .then((data) =>
        setRows((prev) =>
          prev
            ? prev.map((r) =>
                r.item.ticker === item.ticker
                  ? buildBenchmarkRow(item, data)
                  : r,
              )
            : prev,
        ),
      )
      .catch(() =>
        // Per row, never page-level: one company's 502 must not empty the table.
        setRows((prev) =>
          prev
            ? prev.map((r) =>
                r.item.ticker === item.ticker
                  ? { ...r, state: "error" as const }
                  : r,
              )
            : prev,
        ),
      );
  }, []);

  const addCompany = useCallback(
    (company: CompanySearchResult, syncUrl: boolean) => {
      const item: WatchItem = {
        ticker: company.ticker,
        cik: company.cik,
        name: company.name,
      };
      if (tickersRef.current.includes(item.ticker)) return;
      if (tickersRef.current.length >= MAX_ROWS) {
        setTruncated(true);
        return;
      }
      tickersRef.current = [...tickersRef.current, item.ticker];
      setRows((prev) => [...(prev ?? []), loadingRow(item)]);

      if (syncUrl && !addedRef.current.includes(item.ticker)) {
        addedRef.current = [...addedRef.current, item.ticker];
        // replace, not push — picking companies shouldn't spam browser history
        router.replace(`/benchmark?add=${addedRef.current.join(",")}`, {
          scroll: false,
        });
      }
      fetchRow(item);
    },
    [fetchRow, router],
  );

  // localStorage is read after a microtask — never a synchronous setState in an
  // effect body (eslint set-state-in-effect).
  useEffect(() => {
    let cancelled = false;

    async function load() {
      await Promise.resolve();
      if (cancelled) return;

      const seeded = await resolveSeed(initialPeers, initialOnly);
      if (cancelled) return;
      if (seeded) {
        tickersRef.current = seeded.companies.map((c) => c.ticker);
        // Seeded rows are the shareable set from the first render, so a removal
        // has a complete list to write back rather than an empty one.
        addedRef.current = [...tickersRef.current];
        setRows(seeded.companies.map((c) => loadingRow(c)));
        if (seeded.truncated) setTruncated(true);
        setIndustry(seeded.industry);
        seeded.companies.forEach((c) => fetchRow(c));
        return;
      }

      const watched = getWatchlist();
      const seed = watched.slice(0, MAX_ROWS);
      tickersRef.current = seed.map((i) => i.ticker);
      setRows(seed.map(loadingRow));
      if (watched.length > seed.length) setTruncated(true);
      seed.forEach(fetchRow);

      // Ad-hoc tickers from a shared link. Resolved the way /compare resolves
      // ?a=&b=; an unknown ticker is dropped rather than surfaced as an error.
      const wanted = parseTickers(initialAdd).filter(
        (t) => !seed.some((s) => s.ticker === t),
      );
      addedRef.current = wanted;

      wanted.forEach(async (ticker) => {
        const match = await findCompany(ticker);
        if (match && !cancelled) addCompany(match, false);
      });
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [initialAdd, initialOnly, initialPeers, fetchRow, addCompany]);

  /** Drops one row and writes the remaining set back to the URL as an explicit `?add=`
   * list. The peer seed is deliberately not preserved: once a set has been edited it is
   * the user's, and a link that re-derived it from EDGAR would not reopen what they shared. */
  function removeRow(ticker: string) {
    tickersRef.current = tickersRef.current.filter((t) => t !== ticker);
    addedRef.current = addedRef.current.filter((t) => t !== ticker);
    setRows((prev) => (prev ?? []).filter((r) => r.item.ticker !== ticker));
    // `truncated` is left alone on purpose — the companies that did not fit still do not.
    router.replace(
      addedRef.current.length > 0
        ? `/benchmark?add=${addedRef.current.join(",")}`
        : "/benchmark",
      { scroll: false },
    );
  }

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "desc" ? "asc" : "desc" }
        : { key, dir: key === "ticker" ? "asc" : "desc" },
    );
  }

  if (rows === null) {
    return (
      <div>
        <SkeletonTableRows rows={4} />
        {/* A wait longer than a few seconds says where it is (docs/design-system.md).
            EDGAR's peer feed answers a page in 0.7s or 18s at random, so a cold
            industry scan really does run this long the first time. */}
        {initialPeers && (
          <p role="status" className="mt-3 font-sans text-2xs text-muted">
            Looking up peers at SEC EDGAR — this can take up to half a minute the
            first time.
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 w-full">
        <SearchBar
          clearOnSelect
          onSelect={(company) => addCompany(company, true)}
        />
      </div>

      {industry && rows.length > 0 && (
        <p
          className="mb-4 font-sans text-2xs text-muted"
          data-testid="peer-caption"
        >
          Seeded from {industry}. Membership is the filer&apos;s own EDGAR
          classification, which is self-assigned and often stale.
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={Scale}
          title="Nothing to compare yet"
          message="Star a few companies, or search one above, and their margins line up here."
          action={{ href: "/", label: "Search a ticker" }}
        />
      ) : (
        <BenchmarkTable
          rows={sortBenchmarkRows(rows, sort.key, sort.dir)}
          sort={sort}
          onSort={toggleSort}
          onRemove={removeRow}
        />
      )}

      {truncated && (
        <p className="mt-1.5 font-sans text-2xs text-muted">
          Showing the first {MAX_ROWS} companies — the SEC financials endpoint
          is rate limited.
        </p>
      )}
    </div>
  );
}

export default function BenchmarkPage() {
  return (
    <div>
      <h1 className="mb-2 text-2xl text-text">Benchmark</h1>
      <p className="mb-6 text-sm text-muted">
        Margins, leverage and revenue growth for the companies you follow, computed from
        as-reported SEC XBRL figures. Add more with the search box; the URL
        updates so a comparison can be shared.
      </p>

      {/* useSearchParams requires a Suspense boundary in the App Router.
          Drawing it below the heading keeps the title in the prerendered HTML;
          everything under it waits on localStorage anyway. */}
      <Suspense fallback={<SkeletonTableRows rows={4} />}>
        <BenchmarkContent />
      </Suspense>
    </div>
  );
}
