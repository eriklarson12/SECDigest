"use client";

import { useCallback, useEffect, useState, use } from "react";
import Link from "next/link";
import { ArrowLeft, FileQuestion, GitCompare } from "lucide-react";
import {
  ApiError,
  getAnalysis,
  getDrift,
  getFilings,
  getFinancials,
  listAnalyses,
} from "@/lib/api";
import type {
  AnalysisResponse,
  DriftResponse,
  Filing,
  FinancialsResponse,
} from "@/lib/types";
import { eventsBetween, headline, revisionsBy } from "@/lib/changes";
import { EVENT_FORMS, EVENT_SCAN_LIMIT } from "@/lib/eightk";
import { formatDate } from "@/lib/format";
import {
  diffRisks,
  findPriorAnalysis,
  hasSubstantiveRisks,
} from "@/lib/riskDiff";
import ChangeMetrics from "@/components/ChangeMetrics";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
import EventRow from "@/components/EventRow";
import FormBadge from "@/components/FormBadge";
import LanguageDrift from "@/components/LanguageDrift";
import Revisions from "@/components/Revisions";
import RiskFactors from "@/components/RiskFactors";
import SectionHeader from "@/components/SectionHeader";
import { SkeletonHeader, SkeletonSection } from "@/components/Skeleton";

interface SectionState<T> {
  status: "loading" | "error" | "ready";
  data: T | null;
  error: string | null;
}

const LOADING = { status: "loading", data: null, error: null } as const;

interface Pair {
  analysis: AnalysisResponse;
  prior: AnalysisResponse | null;
}

function message(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** Everything that changed between a filing and its prior same-form filing (roadmap 12.2).
 *
 * The pair comes from `findPriorAnalysis` and nothing else, so a mixed-form pair cannot be built;
 * the drift endpoint picks the same prior by the same rule. Each section loads, fails and retries
 * on its own (4.2's precedent), and each always renders something once loaded, so its placeholder
 * never collapses. No LLM call: the page spends no quota. */
export default function ChangesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [pair, setPair] = useState<Pair | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [financials, setFinancials] =
    useState<SectionState<FinancialsResponse>>(LOADING);
  const [drift, setDrift] = useState<SectionState<DriftResponse>>(LOADING);
  const [filings, setFilings] = useState<SectionState<Filing[]>>(LOADING);

  // Loaders only set state from promise callbacks, so they are safe to call from an effect;
  // retries reset to loading in the click handler first.
  const loadFinancials = useCallback((cik: string) => {
    getFinancials(cik)
      .then((data) => setFinancials({ status: "ready", data, error: null }))
      .catch((e) =>
        setFinancials({
          status: "error",
          data: null,
          error: message(e, "Failed to load financials"),
        }),
      );
  }, []);

  const loadDrift = useCallback((analysisId: number) => {
    getDrift(analysisId)
      .then((data) => setDrift({ status: "ready", data, error: null }))
      .catch((e) =>
        setDrift({
          status: "error",
          data: null,
          error: message(e, "Failed to load language drift"),
        }),
      );
  }, []);

  const loadFilings = useCallback((cik: string) => {
    getFilings(cik, EVENT_FORMS.join(","), EVENT_SCAN_LIMIT)
      .then((data) => setFilings({ status: "ready", data, error: null }))
      .catch((e) =>
        setFilings({
          status: "error",
          data: null,
          error: message(e, "Failed to load 8-K filings"),
        }),
      );
  }, []);

  const load = useCallback(() => {
    getAnalysis(Number(id))
      .then(async (analysis) => {
        const history = await listAnalyses(12, 0, analysis.ticker);
        const prior = findPriorAnalysis(analysis, history.analyses);
        setPair({ analysis, prior });
        if (!prior) return;
        loadFinancials(analysis.cik);
        loadDrift(analysis.id);
        loadFilings(analysis.cik);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError(message(e, "Failed to load the comparison"));
      });
  }, [id, loadFinancials, loadDrift, loadFilings]);

  useEffect(() => {
    load();
  }, [load]);

  function retry() {
    setError(null);
    load();
  }

  function retryFinancials() {
    if (!pair) return;
    setFinancials(LOADING);
    loadFinancials(pair.analysis.cik);
  }

  function retryDrift() {
    if (!pair) return;
    setDrift(LOADING);
    loadDrift(pair.analysis.id);
  }

  function retryFilings() {
    if (!pair) return;
    setFilings(LOADING);
    loadFilings(pair.analysis.cik);
  }

  if (notFound) {
    return (
      <EmptyState
        icon={FileQuestion}
        title="Analysis not found"
        message="It may have been removed, or the link is wrong."
        action={{ href: "/", label: "Search a ticker" }}
      />
    );
  }

  if (error) {
    return <ErrorState message={error} onRetry={retry} inset="page" />;
  }

  if (!pair) {
    return (
      <div>
        <SkeletonHeader />
        <div className="mt-9 space-y-9">
          <SkeletonSection rows={4} />
          <SkeletonSection rows={5} />
        </div>
      </div>
    );
  }

  const { analysis, prior } = pair;

  if (!prior) {
    return (
      <EmptyState
        icon={GitCompare}
        title="Pick a same-form filing"
        message={`No earlier ${analysis.form_type} for ${analysis.ticker} has been analyzed. A ${analysis.form_type} is only compared with another ${analysis.form_type}: a quarter set against a year would make every change on this page wrong.`}
        action={{
          href: `/company/${analysis.ticker}`,
          label: `Analyze an earlier ${analysis.form_type}`,
        }}
      />
    );
  }

  const priorLabel = `${prior.form_type} filed ${formatDate(prior.filing_date)}`;
  const risksComparable =
    hasSubstantiveRisks(analysis.risk_factors) &&
    hasSubstantiveRisks(prior.risk_factors);
  const riskDiff = risksComparable
    ? diffRisks(analysis.risk_factors, prior.risk_factors)
    : null;
  const between =
    filings.data && analysis.filing_date && prior.filing_date
      ? eventsBetween(
          filings.data,
          prior.filing_date,
          analysis.filing_date,
          EVENT_SCAN_LIMIT,
        )
      : null;
  const revisions = financials.data
    ? revisionsBy(financials.data.revisions, analysis.accession_number)
    : [];

  return (
    <div>
      <div className="mb-7 border-b border-text pb-4">
        <Link
          href={`/analysis/${analysis.id}`}
          className="inline-flex items-center gap-1.5 font-sans text-2xs text-muted transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ArrowLeft className="h-3 w-3" strokeWidth={1.5} aria-hidden />
          Back to the analysis
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline gap-2.5">
          <h1 className="text-4xl leading-none">
            {analysis.ticker}: what changed
          </h1>
          <FormBadge formType={analysis.form_type} />
        </div>
        <p className="mt-1.5 text-text">{analysis.company_name}</p>
        <p className="font-sans text-2xs tabular-nums text-muted">
          {analysis.form_type} filed {formatDate(analysis.filing_date)} vs{" "}
          {priorLabel}
        </p>
      </div>

      <div className="space-y-9">
        <section aria-label="Headline figures">
          {financials.status === "loading" ? (
            <SkeletonSection rows={4} />
          ) : financials.status === "error" || !financials.data ? (
            <ErrorState
              message={financials.error ?? "Failed to load financials"}
              onRetry={retryFinancials}
            />
          ) : (
            <ChangeMetrics headline={headline(analysis, prior, financials.data)} />
          )}
        </section>

        <section aria-label="Risk factors">
          {riskDiff ? (
            <RiskFactors
              risks={analysis.risk_factors}
              newFlags={riskDiff.isNew}
              dropped={riskDiff.dropped}
              priorLabel={priorLabel}
            />
          ) : (
            <>
              <SectionHeader title="Key risk factors" />
              <p className="mt-3 text-sm text-muted">
                One of these filings reports no material change to its risk
                factors, so there is nothing to compare.
              </p>
            </>
          )}
        </section>

        {/* A div, not a section: the drift card labels its own region when it has data. */}
        <div>
          {drift.status === "loading" ? (
            <SkeletonSection rows={2} />
          ) : drift.status === "error" || !drift.data ? (
            <ErrorState
              message={drift.error ?? "Failed to load language drift"}
              onRetry={retryDrift}
            />
          ) : (
            <LanguageDrift
              drift={drift.data}
              formType={analysis.form_type}
              titled
            />
          )}
        </div>

        <section aria-label="Events between">
          {filings.status === "loading" ? (
            <SkeletonSection rows={3} />
          ) : filings.status === "error" || !between ? (
            <ErrorState
              message={filings.error ?? "Failed to load 8-K filings"}
              onRetry={retryFilings}
            />
          ) : (
            <>
              <SectionHeader
                title="Events between"
                subtitle="8-Ks filed after the prior filing, up to this one"
              />
              {between.events.length === 0 ? (
                <p className="mt-3 text-sm text-muted">
                  No 8-K filed between these two filings.
                </p>
              ) : (
                <ol className="mt-3 space-y-2">
                  {between.events.map((event) => (
                    <EventRow key={event.accession_number} event={event} />
                  ))}
                </ol>
              )}
              {between.truncated && (
                <p className="mt-2 font-sans text-2xs text-muted">
                  Showing the latest {EVENT_SCAN_LIMIT} event filings; earlier
                  ones in this window are not listed.
                </p>
              )}
            </>
          )}
        </section>

        <section aria-label="Revisions">
          {financials.status === "loading" ? (
            <SkeletonSection rows={1} />
          ) : financials.status === "error" ? (
            <ErrorState
              message={financials.error ?? "Failed to load financials"}
              onRetry={retryFinancials}
            />
          ) : revisions.length === 0 ? (
            <>
              <SectionHeader title="Revisions" />
              <p className="mt-3 text-sm text-muted">
                This filing re-reported no earlier figure at a different value.
              </p>
            </>
          ) : (
            <Revisions
              cik={analysis.cik}
              revisions={revisions}
              defaultOpen
            />
          )}
        </section>
      </div>
    </div>
  );
}
