import Link from "next/link";
import { ExternalLink, FileDiff } from "lucide-react";
import type {
  AnalysisResponse,
  AnnualFinancials,
  DriftResponse,
  Filing,
  QuarterlyFinancials,
  TrendPoint,
} from "@/lib/types";
import { formatDate } from "@/lib/format";
import { edgarFilingIndexUrl } from "@/lib/edgar";
import { SITE_URL } from "@/lib/site";
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
import { analysisIdFor, analyzedByAccession, hasNewerFiling } from "@/lib/filings";
import { mergeFlags, textFlags, type PanelFlag } from "@/lib/redflags";
import { hasBreakdown } from "@/lib/segments";
import NewerFilingBanner from "./NewerFilingBanner";
import InsightCard from "./InsightCard";
import FinancialCharts from "./FinancialCharts";
import TrendChart from "./TrendChart";
import MetricsTable from "./MetricsTable";
import RevenueBreakdown from "./RevenueBreakdown";
import LanguageDrift from "./LanguageDrift";
import RiskFactors from "./RiskFactors";
import RedFlags from "./RedFlags";
import ProseSection from "./ProseSection";
import JumpRow, { type JumpLink } from "./JumpRow";
import Button from "./Button";
import FormBadge from "./FormBadge";
import IndustryLine from "./IndustryLine";
import WatchStar from "./WatchStar";
import AskFiling from "./AskFiling";
import SimilarLanguage from "./SimilarLanguage";

const HEADER_LINK_CLASS =
  "inline-flex items-center gap-1.5 font-sans text-2xs text-muted transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

/** A dashboard section. `jump` is set only on sections that render on the first commit, from
 * the analysis alone, so the jump row never links a section that is not there yet. */
interface Section {
  key: string;
  node: React.ReactNode;
  jump?: string;
}

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
  /** Language drift against the prior same-form filing; null when unknown or failed. */
  languageDrift?: DriftResponse | null;
  /** The company's 8-K 4.01/4.02 and NT filings inside the window (roadmap 12.4). */
  companyFlags?: PanelFlag[];
}

export default function AnalysisDashboard({
  analysis,
  tickerHistory = [],
  annualFinancials = [],
  quarterlyFinancials = [],
  latestFiling = null,
  languageDrift = null,
  companyFlags = [],
}: AnalysisDashboardProps) {

  // Trend: exact XBRL annual figures when SEC has them; otherwise fall back
  // to whatever periods have been analyzed so far.
  const annualPoints: TrendPoint[] = buildAnnualPoints(annualFinancials);
  const quarterlyPoints: TrendPoint[] =
    buildQuarterlyPoints(quarterlyFinancials);

  const historyPoints: TrendPoint[] = tickerHistory
    .flatMap((a) =>
      a.filing_date && a.revenue_current !== null
        ? [{ date: a.filing_date, analysis: a }]
        : [],
    )
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map(({ date, analysis }) => ({
      label: formatDate(date),
      revenue: analysis.revenue_current,
      netIncome: analysis.net_income_current,
    }));

  const trendChart =
    annualPoints.length >= 2 || quarterlyPoints.length >= 2 ? (
      <TrendChart
        ticker={analysis.ticker}
        title="Financial Trend"
        caption="As-reported figures from SEC XBRL company facts"
        points={annualPoints}
        quarterlyPoints={quarterlyPoints}
      />
    ) : historyPoints.length >= 2 ? (
      <TrendChart
        ticker={analysis.ticker}
        title="Trend Across Analyzed Filings"
        points={historyPoints}
      />
    ) : null;

  const metricsTable = hasAnnualMetrics(annualFinancials) ? (
    <MetricsTable years={annualFinancials} />
  ) : null;

  const prior = findPriorAnalysis(analysis, tickerHistory);
  const changesHref = `/analysis/${analysis.id}/changes`;
  // Linked only when the newer filing is analyzed and its pair is this one, so the page
  // opens exactly the comparison the banner names.
  const newerId = latestFiling
    ? analysisIdFor(analyzedByAccession(tickerHistory), latestFiling.accession_number)
    : undefined;
  const newerAnalysis = tickerHistory.find((a) => a.id === newerId);
  const newerChangesHref =
    newerAnalysis &&
    findPriorAnalysis(newerAnalysis, tickerHistory)?.accession_number ===
      analysis.accession_number
      ? `/analysis/${newerAnalysis.id}/changes`
      : undefined;
  const drift =
    prior &&
    hasSubstantiveRisks(analysis.risk_factors) &&
    hasSubstantiveRisks(prior.risk_factors)
      ? diffRisks(analysis.risk_factors, prior.risk_factors)
      : null;

  const flags = mergeFlags(textFlags(analysis), companyFlags);

  const entries: (Section | null)[] = [
    {
      key: "metrics",
      node: (
        <div className="flex flex-col gap-6 sm:flex-row sm:gap-14 print:break-inside-avoid">
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
        </div>
      ),
    },
    // Directly under the headline figures: most readers came for the prose, and it arrives
    // with the analysis, so nothing above it lands later.
    analysis.summary
      ? {
          key: "summary",
          jump: "Summary",
          node: <ProseSection title="Executive summary" body={analysis.summary} />,
        }
      : null,
    analysis.management_guidance
      ? {
          key: "guidance",
          jump: "Guidance",
          node: (
            <ProseSection
              title="Management guidance"
              body={analysis.management_guidance}
            />
          ),
        }
      : null,
    analysis.revenue_current || analysis.net_income_current
      ? {
          key: "this-filing",
          jump: "This filing",
          node: <FinancialCharts analysis={analysis} />,
        }
      : null,
    trendChart && { key: "trend", node: trendChart },
    metricsTable && { key: "metrics-table", node: metricsTable },
    // Arrives with the analysis itself, so it never lands after the sections below it.
    hasBreakdown(analysis.segments)
      ? {
          key: "revenue-breakdown",
          jump: "Revenue breakdown",
          node: (
            <RevenueBreakdown
              revenue={analysis.segments}
              formType={analysis.form_type}
            />
          ),
        }
      : null,
    // Above RiskFactors, which already redraws when the page's allSettled batch lands: the
    // company's event flags arrive in that batch, so nothing above this moves when they do.
    // Left out rather than rendered as null, whose empty wrapper would still take a gap.
    flags.length > 0
      ? { key: "red-flags", node: <RedFlags flags={flags} cik={analysis.cik} /> }
      : null,
    analysis.risk_factors.length > 0
      ? {
          key: "risk-factors",
          jump: "Risk factors",
          node:
            drift && prior ? (
              <RiskFactors
                risks={analysis.risk_factors}
                newFlags={drift.isNew}
                dropped={drift.dropped}
                priorLabel={`${prior.form_type} filed ${formatDate(prior.filing_date)}`}
              />
            ) : (
              <RiskFactors risks={analysis.risk_factors} />
            ),
        }
      : null,
    {
      key: "drift",
      node: (
        <LanguageDrift
          drift={languageDrift}
          formType={analysis.form_type}
          changesHref={changesHref}
        />
      ),
    },
    {
      key: "ask",
      jump: "Ask this filing",
      node: <AskFiling analysisId={analysis.id} />,
    },
    // Last on purpose: it self-fetches and renders nothing until it resolves, so it must have
    // nothing below it to displace (frontend/CLAUDE.md).
    {
      key: "similar",
      node: (
        <SimilarLanguage
          analysisId={analysis.id}
          ticker={analysis.ticker}
          sic={analysis.sic}
        />
      ),
    },
  ];
  const sections = entries.filter((s): s is Section => s !== null);
  const jumpLinks: JumpLink[] = sections.flatMap((s) =>
    s.jump ? [{ id: s.key, label: s.jump }] : [],
  );

  return (
    <div>
      <div className="mb-2 border-b border-text pb-4">
        {/* The nav is hidden in print, so a printout names its source here instead. */}
        <p className="mb-3 hidden font-sans text-2xs text-muted print:block">
          SECDigest · {SITE_URL}/analysis/{analysis.id}
        </p>
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
        <IndustryLine
          sic={analysis.sic}
          sicDescription={analysis.sic_description}
        />
        {analysis.filing_date && (
          <p className="font-sans text-2xs tabular-nums text-muted">
            Filed {formatDate(analysis.filing_date)}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
          <a
            href={edgarFilingIndexUrl(analysis.cik, analysis.accession_number)}
            target="_blank"
            rel="noopener noreferrer"
            className={HEADER_LINK_CLASS}
          >
            <ExternalLink className="h-3 w-3" strokeWidth={1.5} aria-hidden />
            View filing on SEC.gov
          </a>
          <Link
            href={`/company/${analysis.ticker}`}
            className={`${HEADER_LINK_CLASS} print:hidden`}
          >
            Company page
          </Link>
        </div>
        {/* Reserved from first paint: the prior arrives in the page's allSettled batch, and
            content that lands late may only fill a line that is already there. */}
        <div className="mt-3 min-h-11 print:hidden">
          {prior && (
            <Button href={changesHref} icon={FileDiff}>
              What changed since {formatDate(prior.filing_date)}
            </Button>
          )}
        </div>
      </div>

      <JumpRow links={jumpLinks} />

      {latestFiling &&
        hasNewerFiling(latestFiling.filing_date, analysis.filing_date) && (
          <NewerFilingBanner
            filing={latestFiling}
            ticker={analysis.ticker}
            changesHref={newerChangesHref}
          />
        )}

      <div className="space-y-9">
        {sections.map((section) => (
          <div key={section.key} id={section.jump ? section.key : undefined}>
            {section.node}
          </div>
        ))}
      </div>
    </div>
  );
}
