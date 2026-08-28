import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type {
  AnalysisResponse,
  AnnualFinancials,
  Filing,
  QuarterlyFinancials,
  TrendPoint,
} from "@/lib/types";
import { formatDate } from "@/lib/format";
import { edgarFilingIndexUrl } from "@/lib/edgar";
import {
  buildAnnualPoints,
  buildQuarterlyPoints,
  hasAnnualMetrics,
} from "@/lib/financials";
import {
  diffRisks,
  findPriorAnalysis,
  hasSubstantiveRisks,
} from "@/lib/riskDiff";
import { hasNewerFiling } from "@/lib/filings";
import NewerFilingBanner from "./NewerFilingBanner";
import InsightCard from "./InsightCard";
import FinancialCharts from "./FinancialCharts";
import TrendChart from "./TrendChart";
import MetricsTable from "./MetricsTable";
import RiskFactors from "./RiskFactors";
import GuidanceSummary from "./GuidanceSummary";
import FormBadge from "./FormBadge";
import WatchStar from "./WatchStar";
import AskFiling from "./AskFiling";

interface AnalysisDashboardProps {
  analysis: AnalysisResponse;
  /** Other stored analyses for the same ticker — trend fallback + risk drift. */
  tickerHistory?: AnalysisResponse[];
  /** Exact annual figures from SEC XBRL — the preferred trend source. */
  annualFinancials?: AnnualFinancials[];
  /** Exact quarterly figures from SEC XBRL — enables the chart toggle. */
  quarterlyFinancials?: QuarterlyFinancials[];
  /** EDGAR's most recent filing for this company, for the "newer filing" banner. */
  latestFiling?: Filing | null;
}

export default function AnalysisDashboard({
  analysis,
  tickerHistory = [],
  annualFinancials = [],
  quarterlyFinancials = [],
  latestFiling = null,
}: AnalysisDashboardProps) {
  // Trend: exact XBRL annual figures when SEC has them; otherwise fall back
  // to whatever periods have been analyzed so far.
  const annualPoints: TrendPoint[] = buildAnnualPoints(annualFinancials);
  const quarterlyPoints: TrendPoint[] =
    buildQuarterlyPoints(quarterlyFinancials);

  const historyPoints: TrendPoint[] = tickerHistory
    .filter((a) => a.filing_date && a.revenue_current !== null)
    .sort((a, b) => (a.filing_date! < b.filing_date! ? -1 : 1))
    .map((a) => ({
      label: formatDate(a.filing_date!),
      revenue: a.revenue_current,
      netIncome: a.net_income_current,
    }));

  const trendChart =
    annualPoints.length >= 2 || quarterlyPoints.length >= 2 ? (
      <TrendChart
        key="trend"
        ticker={analysis.ticker}
        title="Financial Trend"
        caption="As-reported figures from SEC XBRL company facts"
        points={annualPoints}
        quarterlyPoints={quarterlyPoints}
      />
    ) : historyPoints.length >= 2 ? (
      <TrendChart
        key="trend"
        ticker={analysis.ticker}
        title="Trend Across Analyzed Filings"
        points={historyPoints}
      />
    ) : null;

  const metricsTable = hasAnnualMetrics(annualFinancials) ? (
    <MetricsTable key="metrics-table" years={annualFinancials} />
  ) : null;

  const prior = findPriorAnalysis(analysis, tickerHistory);
  const drift =
    prior &&
    hasSubstantiveRisks(analysis.risk_factors) &&
    hasSubstantiveRisks(prior.risk_factors)
      ? diffRisks(analysis.risk_factors, prior.risk_factors)
      : null;

  const sections: React.ReactNode[] = [
    <div key="metrics" className="flex flex-col gap-6 sm:flex-row sm:gap-14">
      <InsightCard
        label="Revenue"
        value={analysis.revenue_current}
        changePercent={analysis.revenue_yoy_change_pct}
      />
      <InsightCard
        label="Net Income"
        value={analysis.net_income_current}
        changePercent={analysis.net_income_yoy_change_pct}
      />
    </div>,
    <FinancialCharts key="chart" analysis={analysis} />,
    trendChart,
    metricsTable,
    <GuidanceSummary
      key="guidance"
      guidance={analysis.management_guidance}
      summary={analysis.summary}
    />,
    drift && prior ? (
      <RiskFactors
        key="risks"
        risks={analysis.risk_factors}
        newFlags={drift.isNew}
        dropped={drift.dropped}
        priorLabel={`${prior.form_type} filed ${formatDate(prior.filing_date)}`}
      />
    ) : (
      <RiskFactors key="risks" risks={analysis.risk_factors} />
    ),
    <AskFiling key="ask" analysisId={analysis.id} />,
  ].filter(Boolean);

  return (
    <div>
      <div className="mb-7 border-b border-text pb-4">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-4xl leading-none">
            <Link
              href={`/company/${analysis.ticker}`}
              className="text-text transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {analysis.ticker}
            </Link>
          </h1>
          <FormBadge formType={analysis.form_type} />
          <WatchStar
            item={{
              ticker: analysis.ticker,
              cik: analysis.cik,
              name: analysis.company_name,
            }}
          />
        </div>
        <p className="mt-1.5 text-text">{analysis.company_name}</p>
        {analysis.filing_date && (
          <p className="font-sans text-[11px] tabular-nums text-muted">
            Filed {formatDate(analysis.filing_date)}
          </p>
        )}
        <a
          href={edgarFilingIndexUrl(analysis.cik, analysis.accession_number)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex items-center gap-1.5 font-sans text-[11px] text-muted transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ExternalLink className="h-3 w-3" strokeWidth={1.5} aria-hidden />
          View filing on SEC.gov
        </a>
      </div>

      {latestFiling &&
        hasNewerFiling(latestFiling.filing_date, analysis.filing_date) && (
          <NewerFilingBanner filing={latestFiling} ticker={analysis.ticker} />
        )}

      <div className="space-y-8">
        {sections.map((section, i) => (
          <div key={i}>{section}</div>
        ))}
      </div>
    </div>
  );
}
