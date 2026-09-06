"use client";

import { useCallback, useEffect, useState, use } from "react";
import Link from "next/link";
import { FileQuestion, FileSearch, Scale, TrendingUp } from "lucide-react";
import {
  searchCompanies,
  getFinancials,
  getCompanyProfile,
  listAnalyses,
} from "@/lib/api";
import type {
  CompanySearchResult,
  CompanyProfile,
  FinancialsResponse,
  AnalysisResponse,
} from "@/lib/types";
import {
  buildAnnualPoints,
  buildQuarterlyPoints,
  hasAnnualMetrics,
} from "@/lib/financials";
import { useAnalyze } from "@/lib/useAnalyze";
import { FORM_FILTERS, nounFor, useFilings } from "@/lib/useFilings";
import SegmentedControl from "@/components/SegmentedControl";
import EmptyState from "@/components/EmptyState";
import FilingList from "@/components/FilingList";
import AnalysisHistory from "@/components/AnalysisHistory";
import IndustryLine from "@/components/IndustryLine";
import TrendChart from "@/components/TrendChart";
import MetricsTable from "@/components/MetricsTable";
import WatchStar from "@/components/WatchStar";
import LoadingState from "@/components/LoadingState";
import {
  SkeletonHeader,
  SkeletonChart,
  SkeletonFilingList,
  SkeletonTableRows,
} from "@/components/Skeleton";

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

type ResolveStatus = "loading" | "not-found" | "error" | "resolved";

interface SectionState<T> {
  status: "loading" | "error" | "ready";
  data: T;
  error: string | null;
}

const retryButtonClass =
  "mt-3 h-11 cursor-pointer border border-border bg-surface px-5 text-sm font-medium text-text transition-colors duration-200 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

function ErrorBlock({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="py-10 text-center">
      <p role="alert" className="text-sm text-negative">
        {message}
      </p>
      <button onClick={onRetry} className={retryButtonClass}>
        Retry
      </button>
    </div>
  );
}

export default function CompanyPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker: rawTicker } = use(params);
  const ticker = rawTicker.toUpperCase();
  const tickerValid = TICKER_RE.test(ticker);
  const {
    isAnalyzing,
    stage,
    error: analyzeError,
    analyze,
    clearError,
  } = useAnalyze();

  const [resolveStatus, setResolveStatus] = useState<ResolveStatus>("loading");
  const [company, setCompany] = useState<CompanySearchResult | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const {
    filings,
    filter: filingFilter,
    selectFilter: selectFilingFilter,
    status: filingStatus,
    error: filingError,
    retry: retryFilings,
  } = useFilings(company?.cik ?? null);

  const [financials, setFinancials] = useState<
    SectionState<FinancialsResponse | null>
  >({
    status: "loading",
    data: null,
    error: null,
  });
  // Not a SectionState: a company with no classification renders nothing, which is the
  // same output as a failed lookup, so there is no error or skeleton worth showing.
  // Loaded is tracked apart from the value because both a failed lookup and an
  // unclassified filer arrive as null, and the peers button reads differently in each:
  // nothing at all while it is still in flight, disabled with a reason once it is known.
  const [profile, setProfile] = useState<{
    loaded: boolean;
    data: CompanyProfile | null;
  }>({ loaded: false, data: null });
  const [history, setHistory] = useState<SectionState<AnalysisResponse[]>>({
    status: "loading",
    data: [],
    error: null,
  });

  // `retryTick` reruns this effect after a failed lookup. State only updates inside
  // promise callbacks (never sync in effect body) so a stale ticker can't clobber a newer one.
  useEffect(() => {
    if (!tickerValid) return;
    let cancelled = false;
    searchCompanies(ticker)
      .then((results) => {
        if (cancelled) return;
        const match = results.find((c) => c.ticker.toUpperCase() === ticker);
        if (match) {
          setCompany(match);
          setResolveStatus("resolved");
        } else {
          setResolveStatus("not-found");
        }
      })
      .catch(() => {
        if (!cancelled) setResolveStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, tickerValid, retryTick]);

  // Loaders only set state from promise callbacks (safe to call from an effect); retry
  // buttons reset to "loading" in a click handler first, then call the same loader.
  const loadFinancials = useCallback((cik: string) => {
    getFinancials(cik)
      .then((data) => setFinancials({ status: "ready", data, error: null }))
      .catch((e) =>
        setFinancials({
          status: "error",
          data: null,
          error: e instanceof Error ? e.message : "Failed to load financials",
        }),
      );
  }, []);

  const loadProfile = useCallback((cik: string) => {
    getCompanyProfile(cik)
      .then((data) => setProfile({ loaded: true, data }))
      .catch(() => setProfile({ loaded: true, data: null }));
  }, []);

  const loadHistory = useCallback((t: string) => {
    listAnalyses(12, 0, t)
      .then((res) =>
        setHistory({ status: "ready", data: res.analyses, error: null }),
      )
      .catch((e) =>
        setHistory({
          status: "error",
          data: [],
          error: e instanceof Error ? e.message : "Failed to load analyses",
        }),
      );
  }, []);

  function retryFinancials() {
    if (!company) return;
    setFinancials((s) => ({ ...s, status: "loading", error: null }));
    loadFinancials(company.cik);
  }

  function retryHistory() {
    if (!company) return;
    setHistory((s) => ({ ...s, status: "loading", error: null }));
    loadHistory(company.ticker);
  }

  // Sections load in parallel and fail independently once the company is known.
  // Filings are the exception: useFilings owns its own fetch, keyed on the filter.
  useEffect(() => {
    if (!company) return;
    loadFinancials(company.cik);
    loadProfile(company.cik);
    loadHistory(company.ticker);
  }, [company, loadFinancials, loadProfile, loadHistory]);

  if (isAnalyzing) {
    return <LoadingState stage={stage} />;
  }

  if (!tickerValid) {
    return (
      <EmptyState
        icon={FileQuestion}
        title="Invalid ticker"
        message="Ticker symbols are 1-10 characters — letters, digits, dots, or hyphens."
        action={{ href: "/", label: "Search a ticker" }}
      />
    );
  }

  if (resolveStatus === "not-found") {
    return (
      <EmptyState
        icon={FileSearch}
        title="Unknown ticker"
        message={`No company found for "${ticker}".`}
        action={{ href: "/", label: "Search a ticker" }}
      />
    );
  }

  if (resolveStatus === "error") {
    return (
      <ErrorBlock
        message="Couldn't look up that ticker — try again."
        onRetry={() => setRetryTick((n) => n + 1)}
      />
    );
  }

  if (resolveStatus === "loading" || !company) {
    return (
      <div>
        <SkeletonHeader />
        <div className="mt-6">
          <SkeletonChart />
        </div>
        <div className="mt-6">
          <SkeletonFilingList />
        </div>
        <div className="mt-6">
          <SkeletonTableRows rows={4} />
        </div>
      </div>
    );
  }

  const annualPoints = financials.data
    ? buildAnnualPoints(financials.data.years)
    : [];
  const quarterlyPoints = financials.data
    ? buildQuarterlyPoints(financials.data.quarters ?? [])
    : [];
  const hasChart = annualPoints.length >= 2 || quarterlyPoints.length >= 2;
  const hasTable = hasAnnualMetrics(financials.data?.years ?? []);

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl text-text">{company.ticker}</h1>
          <WatchStar
            item={{
              ticker: company.ticker,
              cik: company.cik,
              name: company.name,
            }}
          />
        </div>
        <p className="mt-1 text-muted">{company.name}</p>
        {profile.data && (
          <IndustryLine
            sic={profile.data.sic}
            sicDescription={profile.data.sic_description}
          />
        )}
        {/* Nothing until the lookup lands: a control that enables itself under the
            cursor is worse than one that arrives. */}
        {profile.loaded &&
          (profile.data?.sic ? (
            <Link
              href={`/benchmark?peers=${company.ticker}`}
              className="mt-3 inline-flex h-11 cursor-pointer items-center gap-2 border border-text px-4 font-sans text-xs tracking-[0.06em] text-text transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Scale className="h-4 w-4" strokeWidth={1.5} aria-hidden />
              Compare to peers
            </Link>
          ) : (
            <>
              <button
                disabled
                aria-describedby="no-peers-reason"
                className="mt-3 inline-flex h-11 items-center gap-2 border border-border px-4 font-sans text-xs tracking-[0.06em] text-muted"
              >
                <Scale className="h-4 w-4" strokeWidth={1.5} aria-hidden />
                Compare to peers
              </button>
              <p
                id="no-peers-reason"
                className="mt-1 font-sans text-2xs text-muted"
              >
                EDGAR has not classified this filer, so there are no peers to
                look up.
              </p>
            </>
          ))}
      </div>

      {analyzeError && (
        <div
          role="alert"
          className="mb-4 border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative"
        >
          {analyzeError}
        </div>
      )}

      <div className="space-y-6">
        <section aria-label="Financials">
          {financials.status === "loading" ? (
            <SkeletonChart />
          ) : financials.status === "error" ? (
            <ErrorBlock
              message={financials.error ?? "Failed to load financials"}
              onRetry={retryFinancials}
            />
          ) : !hasChart && !hasTable ? (
            <EmptyState
              icon={TrendingUp}
              title="No financial data"
              message="SEC XBRL data isn't available yet for this company."
            />
          ) : (
            <div className="space-y-6">
              {hasChart && (
                <TrendChart
                  ticker={company.ticker}
                  title="Financial Trend"
                  caption="As-reported figures from SEC XBRL company facts"
                  points={annualPoints}
                  quarterlyPoints={quarterlyPoints}
                />
              )}
              {hasTable && (
                <MetricsTable years={financials.data?.years ?? []} />
              )}
            </div>
          )}
        </section>

        <section aria-label="Recent filings">
          {/* Heading and filter render in every state, so filtering to a form type
              this company hasn't filed can't strip away the way back. */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-text">Recent Filings</h2>
            <SegmentedControl
              label="Filter filings by form type"
              options={FORM_FILTERS}
              value={filingFilter}
              onChange={selectFilingFilter}
            />
          </div>
          {filingStatus === "loading" ? (
            <SkeletonFilingList />
          ) : filingStatus === "error" ? (
            <ErrorBlock
              message={filingError ?? "Failed to load filings"}
              onRetry={retryFilings}
            />
          ) : filings.length === 0 ? (
            <EmptyState
              icon={FileSearch}
              title={`No ${nounFor(filingFilter)} filings found`}
              message={`EDGAR has no matching reports for ${company.ticker}.`}
            />
          ) : (
            <FilingList
              filings={filings}
              onAnalyze={(filing) => {
                clearError();
                analyze(company, filing);
              }}
              isAnalyzing={isAnalyzing}
            />
          )}
        </section>

        <section aria-label="Past analyses">
          <h2 className="mb-3 text-lg font-semibold text-text">
            Past Analyses
          </h2>
          {history.status === "loading" ? (
            <SkeletonTableRows rows={4} />
          ) : history.status === "error" ? (
            <ErrorBlock
              message={history.error ?? "Failed to load analyses"}
              onRetry={retryHistory}
            />
          ) : (
            <AnalysisHistory analyses={history.data} />
          )}
        </section>
      </div>
    </div>
  );
}
