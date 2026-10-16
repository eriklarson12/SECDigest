"use client";

import { useEffect, useState, use } from "react";
import { FileQuestion, FileSearch, Rss, Scale, TrendingUp } from "lucide-react";
import {
  companyFeedUrl,
  searchCompanies,
  getFinancials,
  getCompanyProfile,
  getInsiders,
  listAnalyses,
} from "@/lib/api";
import type { AnalysisResponse, CompanySearchResult } from "@/lib/types";
import {
  buildAnnualPoints,
  buildQuarterlyPoints,
  hasAnnualMetrics,
} from "@/lib/financials";
import { latestTextFlags, mergeFlags, type PanelFlag } from "@/lib/redflags";
import { useAnalyze } from "@/lib/useAnalyze";
import { FORM_FILTERS, nounFor, useFilings } from "@/lib/useFilings";
import { useSection } from "@/lib/useSection";
import { TICKER_RE } from "@/lib/ticker";
import SegmentedControl from "@/components/SegmentedControl";
import Button from "@/components/Button";
import EmptyState from "@/components/EmptyState";
import ErrorState, { ErrorNotice } from "@/components/ErrorState";
import FilingList from "@/components/FilingList";
import AnalysisHistory from "@/components/AnalysisHistory";
import RecentEvents from "@/components/RecentEvents";
import RedFlags from "@/components/RedFlags";
import InsiderActivity from "@/components/InsiderActivity";
import AskCompany from "@/components/AskCompany";
import IndustryLine from "@/components/IndustryLine";
import TrendChart from "@/components/TrendChart";
import MetricsTable from "@/components/MetricsTable";
import RatiosTable from "@/components/RatiosTable";
import PercentileRanks from "@/components/PercentileRanks";
import Revisions from "@/components/Revisions";
import WatchStar from "@/components/WatchStar";
import LoadingState from "@/components/LoadingState";
import {
  SkeletonHeader,
  SkeletonChart,
  SkeletonFilingList,
  SkeletonTableRows,
} from "@/components/Skeleton";

type ResolveStatus = "loading" | "not-found" | "error" | "resolved";

interface History {
  analyses: AnalysisResponse[];
  flags: PanelFlag[];
}

const NO_HISTORY: History = { analyses: [], flags: [] };

/** The red-flag panel's text flags come from the newest analysis, so they land with the rows. */
async function loadHistory(ticker: string): Promise<History> {
  const res = await listAnalyses(12, 0, ticker);
  return { analyses: res.analyses, flags: latestTextFlags(res.analyses, new Date()) };
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

  // `withEvents` widens the same request rather than adding one: the 8-K rows for the
  // events section below come back with the filing list (roadmap 9.2).
  const {
    filings,
    events,
    filter: filingFilter,
    selectFilter: selectFilingFilter,
    status: filingStatus,
    error: filingError,
    retry: retryFilings,
    flags: eventFlags,
  } = useFilings(company?.cik ?? null, { withEvents: true });

  // Sections load in parallel and fail independently once the company is known.
  // Filings are the exception: useFilings owns its own fetch, keyed on the filter.
  const financials = useSection(
    company?.cik ?? null,
    getFinancials,
    null,
    "Failed to load financials",
  );
  // A company with no classification renders nothing, which is the same output as a failed
  // lookup, so the error is never shown. Both arrive as null; the peers button tells them
  // apart from status: nothing while in flight, disabled with a reason once it is known.
  const profile = useSection(
    company?.cik ?? null,
    getCompanyProfile,
    null,
    "Failed to load the industry",
  );
  const history = useSection(
    company?.ticker ?? null,
    loadHistory,
    NO_HISTORY,
    "Failed to load analyses",
  );
  const insiders = useSection(
    company?.cik ?? null,
    getInsiders,
    null,
    "Failed to load insider activity",
  );

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
      <ErrorState
        message="Couldn't look up that ticker — try again."
        onRetry={() => setRetryTick((n) => n + 1)}
        inset="page"
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
        <a
          href={companyFeedUrl(company.ticker)}
          type="application/atom+xml"
          className="inline-flex min-h-11 items-center gap-1.5 font-sans text-2xs text-muted transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary print:hidden"
        >
          <Rss className="h-3 w-3" strokeWidth={1.5} aria-hidden />
          Atom feed of new filings
        </a>
        {profile.data && (
          <IndustryLine
            sic={profile.data.sic}
            sicDescription={profile.data.sic_description}
          />
        )}
        {/* Nothing until the lookup lands: a control that enables itself under the
            cursor is worse than one that arrives. */}
        {profile.status !== "loading" &&
          (profile.data?.sic ? (
            <div className="mt-3">
              <Button href={`/benchmark?peers=${company.ticker}`} icon={Scale}>
                Compare to peers
              </Button>
            </div>
          ) : (
            <>
              <div className="mt-3">
                <Button icon={Scale} disabled describedBy="no-peers-reason">
                  Compare to peers
                </Button>
              </div>
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
        <div className="mb-4">
          <ErrorNotice message={analyzeError} />
        </div>
      )}

      <div className="space-y-6">
        <section aria-label="Financials">
          {financials.status === "loading" ? (
            <SkeletonChart />
          ) : financials.status === "error" ? (
            <ErrorState
              message={financials.error ?? "Failed to load financials"}
              onRetry={financials.retry}
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
              {/* Directly under the table it annotates. It arrives in the same response,
                  so it displaces nothing the table has not already displaced. */}
              <Revisions
                cik={company.cik}
                revisions={financials.data?.revisions ?? []}
              />
              {/* Below Revisions, which annotates the metrics table. Same response, same exemption. */}
              <RatiosTable years={financials.data?.years ?? []} />
              {/* Same response, same exemption as Revisions above. */}
              <PercentileRanks
                percentiles={financials.data?.percentiles ?? []}
              />
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
            <ErrorState
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
            <ErrorState
              message={history.error ?? "Failed to load analyses"}
              onRetry={history.retry}
            />
          ) : (
            <AnalysisHistory analyses={history.data.analyses} />
          )}
        </section>

        {/* No skeleton: a filer with no 8-Ks renders nothing here, so only sections that also
            land late may sit below it, RedFlags and InsiderActivity (frontend/CLAUDE.md). Rendered unconditionally — it is empty until the first
            response and holds the last good rows through a refetch, so toggling the
            form-type filter above does not blink a section that filter does not govern. */}
        <RecentEvents events={events} />

        {/* After RecentEvents, for the same rule: it renders nothing without a flag, and its
            two sources (the filings request and the history request) land separately. */}
        <RedFlags
          flags={mergeFlags(eventFlags, history.data.flags)}
          cik={company.cik}
          heading="page"
        />

        {/* Below the sections above for the same rule: it renders nothing until its scope lands,
            and nothing at all for a company with no indexed filing. Above InsiderActivity, whose
            cold request is far slower than this one RPC. */}
        <AskCompany cik={company.cik} />

        {/* Last of all: it renders nothing until its request lands, and a cold one reads up to
            21 EDGAR documents, so it is usually the page's final commit. Only RedFlags landing
            after a warm response can still push it down. */}
        <InsiderActivity
          status={insiders.status}
          activity={insiders.data}
          error={insiders.error}
          onRetry={insiders.retry}
          cik={company.cik}
        />
      </div>
    </div>
  );
}
