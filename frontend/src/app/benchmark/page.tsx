"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Scale, X } from "lucide-react";
import SearchBar from "@/components/SearchBar";
import Delta from "@/components/Delta";
import EmptyState from "@/components/EmptyState";
import { SkeletonTableRows } from "@/components/Skeleton";
import { getFinancials, getPeers, searchCompanies } from "@/lib/api";
import { formatCurrency, formatIndustry, formatPercent } from "@/lib/format";
import {
  buildBenchmarkRow,
  sortBenchmarkRows,
  type BenchmarkRow,
  type SortDir,
  type SortKey,
} from "@/lib/ratios";
import { getWatchlist } from "@/lib/watchlist";
import type { CompanySearchResult, WatchItem } from "@/lib/types";

/** Each row costs one /api/financials request and that route allows 30/min.
 * The watchlist itself caps at 20, so it alone could blow the budget. */
const MAX_ROWS = 10;

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "ticker", label: "Ticker", numeric: false },
  { key: "fiscalYear", label: "FY", numeric: true },
  { key: "revenue", label: "Revenue", numeric: true },
  { key: "netMargin", label: "Net margin", numeric: true },
  { key: "ocfMargin", label: "OCF margin", numeric: true },
  { key: "revenueCagr", label: "3-yr rev CAGR", numeric: true },
];

function loadingRow(item: WatchItem): BenchmarkRow {
  return {
    item,
    state: "loading",
    fiscalYear: null,
    revenue: null,
    netMargin: null,
    ocfMargin: null,
    revenueCagr: null,
  };
}

/** A margin is a level, not a change: it keeps its own minus sign, so the figure
 * reads correctly with colour ignored entirely. Colour only reinforces a loss. */
function Margin({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted">&mdash;</span>;
  return (
    <span className={value < 0 ? "text-negative" : "text-text"}>
      {formatPercent(value)}
    </span>
  );
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
  // An explicit set, from the "Benchmark these" button on a language-peer card (roadmap 9.1).
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

  /** Peers for the seed ticker, or null when there is no seed or it did not resolve.
   * Two hops, the same pair `?add=` already makes: the URL carries a ticker because
   * that is what a person can read and type, and the endpoint is keyed on a CIK. */
  const seedPeers = useCallback(async (ticker: string) => {
    if (!TICKER_RE.test(ticker)) return null;
    try {
      const results = await searchCompanies(ticker);
      const match = results.find((c) => c.ticker.toUpperCase() === ticker);
      if (!match) return null;
      return await getPeers(match.cik);
    } catch {
      return null;
    }
  }, []);

  // localStorage is read after a microtask — never a synchronous setState in an
  // effect body (eslint set-state-in-effect).
  useEffect(() => {
    let cancelled = false;

    async function load() {
      await Promise.resolve();
      if (cancelled) return;

      // An industry seed replaces the watchlist rather than joining it: the caption
      // below names a SIC, and unrelated starred companies under it would make that
      // caption false. A seed that fails to resolve falls through to the watchlist.
      if (initialPeers) {
        const found = await seedPeers(initialPeers);
        if (cancelled) return;
        if (found && found.peers.length > 0) {
          const seed = found.peers.slice(0, MAX_ROWS);
          tickersRef.current = seed.map((c) => c.ticker);
          // Seeded rows are the shareable set from the first render, so a removal
          // has a complete list to write back rather than an empty one.
          addedRef.current = [...tickersRef.current];
          setRows(seed.map((c) => loadingRow(c)));
          if (found.peers.length > seed.length) setTruncated(true);
          setIndustry(
            formatIndustry(found.sic, found.sic_description) ?? null,
          );
          seed.forEach((c) => fetchRow(c));
          return;
        }
      }

      // Same replace-the-watchlist rule as the peer seed above, for the same reason: the
      // caption names where the set came from, and unrelated starred companies would make it false.
      // De-duped here rather than downstream: this path bypasses addCompany, which is what
      // dedupes `?add=`, and these URLs are meant to be shared and hand-edited.
      const only = [
        ...new Set(
          initialOnly
            .split(",")
            .map((t) => t.trim().toUpperCase())
            .filter((t) => TICKER_RE.test(t)),
        ),
      ];
      if (only.length > 0) {
        const capped = only.slice(0, MAX_ROWS);
        // Resolved together, then set once: the set arrives in the order the card ranked it,
        // and an unresolvable ticker is dropped rather than leaving the table on a skeleton.
        const found = (
          await Promise.all(
            capped.map(async (ticker) => {
              try {
                const results = await searchCompanies(ticker);
                return (
                  results.find((c) => c.ticker.toUpperCase() === ticker) ?? null
                );
              } catch {
                return null;
              }
            }),
          )
        ).filter((c) => c !== null);
        if (cancelled) return;

        if (found.length > 0) {
          tickersRef.current = found.map((c) => c.ticker);
          // The shareable set from the first render, so a removal has a complete list to
          // write back rather than an empty one.
          addedRef.current = [...tickersRef.current];
          setRows(found.map((c) => loadingRow(c)));
          if (only.length > capped.length) setTruncated(true);
          found.forEach((c) => fetchRow(c));
          return;
        }
        // Nothing resolved — fall through to the watchlist, as a dead `?peers=` seed does.
      }

      const watched = getWatchlist();
      const seed = watched.slice(0, MAX_ROWS);
      tickersRef.current = seed.map((i) => i.ticker);
      setRows(seed.map(loadingRow));
      if (watched.length > seed.length) setTruncated(true);
      seed.forEach(fetchRow);

      // Ad-hoc tickers from a shared link. Resolved the way /compare resolves
      // ?a=&b=; an unknown ticker is dropped rather than surfaced as an error.
      const wanted = initialAdd
        .split(",")
        .map((t) => t.trim().toUpperCase())
        .filter((t) => TICKER_RE.test(t))
        .filter((t) => !seed.some((s) => s.ticker === t));
      addedRef.current = wanted;

      wanted.forEach(async (ticker) => {
        try {
          const results = await searchCompanies(ticker);
          const match = results.find((c) => c.ticker.toUpperCase() === ticker);
          if (match && !cancelled) addCompany(match, false);
        } catch {
          // best-effort — the search box above still works
        }
      });
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [initialAdd, initialOnly, initialPeers, seedPeers, fetchRow, addCompany]);

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

  const sorted = sortBenchmarkRows(rows, sort.key, sort.dir);

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
        <div className="overflow-x-auto">
          <table className="w-full text-left font-sans text-xs">
            <caption className="sr-only">
              Peer financial ratios, sortable by column
            </caption>
            <thead>
              <tr className="border-b border-text text-2xs uppercase tracking-[0.06em] text-muted">
                {COLUMNS.map(({ key, label, numeric }) => (
                  <th
                    key={key}
                    scope="col"
                    aria-sort={
                      sort.key === key
                        ? sort.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className={`whitespace-nowrap py-1.5 font-normal ${
                      numeric ? "pl-4 text-right" : "pr-4"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(key)}
                      className="cursor-pointer uppercase tracking-[0.06em] transition-colors duration-150 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      {label}
                      <span aria-hidden className="ml-1">
                        {sort.key === key
                          ? sort.dir === "asc"
                            ? "▲"
                            : "▼"
                          : ""}
                      </span>
                    </button>
                  </th>
                ))}
                {/* `relative` is load-bearing: sr-only is position:absolute, and in the
                    last column of a horizontally scrolling table it would otherwise
                    resolve against the page and widen the document at 375px. */}
                <th scope="col" className="relative w-11">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr
                  key={row.item.ticker}
                  className="border-b border-border transition-colors duration-150 hover:bg-surface-2"
                >
                  <td className="py-1.5 pr-4">
                    <Link
                      href={`/company/${row.item.ticker}`}
                      className="font-serif text-sm text-text transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      {row.item.ticker}
                    </Link>
                    <span className="ml-2 text-muted">{row.item.name}</span>
                  </td>

                  {row.state === "loading" ? (
                    <td colSpan={5} className="py-1.5 pl-4">
                      <div className="ml-auto h-4 w-40 bg-surface-2 motion-safe:animate-pulse" />
                    </td>
                  ) : row.state === "error" ? (
                    <td
                      colSpan={5}
                      className="py-1.5 pl-4 text-right text-muted"
                    >
                      Couldn&apos;t load financials
                    </td>
                  ) : (
                    <>
                      <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums text-muted">
                        {row.fiscalYear ?? "—"}
                      </td>
                      <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums text-text">
                        {row.revenue == null
                          ? "—"
                          : formatCurrency(row.revenue)}
                      </td>
                      <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums">
                        <Margin value={row.netMargin} />
                      </td>
                      <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums">
                        <Margin value={row.ocfMargin} />
                      </td>
                      <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums">
                        {row.revenueCagr == null ? (
                          <span className="text-muted">&mdash;</span>
                        ) : (
                          <Delta value={row.revenueCagr} />
                        )}
                      </td>
                    </>
                  )}

                  <td className="py-1.5 pl-2">
                    <button
                      type="button"
                      onClick={() => removeRow(row.item.ticker)}
                      aria-label={`Remove ${row.item.ticker} from the comparison`}
                      title="Remove from the comparison"
                      className="flex h-11 w-11 cursor-pointer items-center justify-center text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <X className="h-4 w-4" strokeWidth={1.5} aria-hidden />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <p className="mt-3 font-sans text-2xs text-muted">
          Margins are net income and operating cash flow as a share of revenue.
          CAGR is compound annual revenue growth across three fiscal years, left
          blank where a company has not tagged that many.
        </p>
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
        Margins and revenue growth for the companies you follow, computed from
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
