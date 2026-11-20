import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import EvalMetricChart from "@/components/EvalMetricChart";
import SectionHeader from "@/components/SectionHeader";
import {
  formatCount,
  formatDate,
  formatPercent,
  formatScore,
} from "@/lib/format";
import {
  calibrationLines,
  LOSS_MODEL_LABELS,
  lossModelVerdict,
  newestRun,
  persistenceRates,
  questionCountChanged,
  series,
  toPercent,
  type CalibrationRow,
  type EvalHistory,
} from "@/lib/evals";
import { REPO_URL } from "@/lib/site";
import data from "@/data/eval-history.json";

export const metadata: Metadata = {
  title: "Eval history",
  description:
    "Every committed run of SECDigest's extraction and Q&A evals, and a backtested net-loss base rate: accuracy against SEC XBRL, groundedness, refusal, retrieval and calibration.",
};

const history = data as EvalHistory;

const SOURCE_URL = `${REPO_URL}/blob/main/backend/evals`;
const MODEL_SOURCE_URL = `${REPO_URL}/tree/main/backend/ml`;

const LINK_CLASS =
  "inline-flex items-center gap-1.5 font-sans text-2xs text-muted transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

const TH = "py-1.5 pl-4";
const TD = "whitespace-nowrap py-1.5 pl-4 text-text";
const HEAD_ROW =
  "border-b border-border text-right text-2xs uppercase tracking-[0.06em] text-muted";
const BODY_ROW = "border-b border-border text-right";

function pct(value: number | null): string {
  return formatPercent(toPercent(value));
}

function decileRange(decile: number): string {
  return `${decile * 10}–${decile * 10 + 10}%`;
}

function CalibrationCells({ row }: { row: CalibrationRow | null }) {
  if (!row) {
    return (
      <>
        <td className={`${TD} text-muted`}>0</td>
        <td className={TD} />
        <td className={TD} />
      </>
    );
  }
  return (
    <>
      <td className={`${TD} text-muted`}>{formatCount(row.count)}</td>
      <td className={TD}>{pct(row.mean_predicted)}</td>
      <td className={TD}>{pct(row.observed_rate)}</td>
    </>
  );
}

export default function EvalsPage() {
  const { extraction, qa } = history;
  const lossRun = newestRun(history.loss_model ?? []);
  const persistence = lossRun ? persistenceRates(lossRun) : null;
  const newestFirst = <T extends { run_date: string }>(runs: T[]) =>
    [...runs].sort((a, b) => b.run_date.localeCompare(a.run_date));

  return (
    <div>
      <h1 className="mb-2 text-2xl text-text">Eval history</h1>
      <p className="mb-8 max-w-[70ch] text-sm text-muted">
        Two evals measure the real pipeline. Extraction is checked against
        as-reported SEC XBRL figures. Q&amp;A is checked for groundedness: every
        figure an answer states must appear in the excerpts it was given. Every
        push re-scores each run below under the current rules. A third section
        backtests a simple forecast against SEC&apos;s own data.
      </p>

      <div className="space-y-10">
        <section aria-label="Extraction accuracy">
          <SectionHeader
            as="h2"
            title="Extraction accuracy"
            subtitle="Figures within 1% of XBRL, across a golden set of 10-Ks"
          />
          <div className="mt-3 grid gap-6 md:grid-cols-2">
            <EvalMetricChart
              title="Fields correct"
              points={series(extraction, "accuracy")}
            />
          </div>
        </section>

        <section aria-label="Q&A">
          <SectionHeader
            as="h2"
            title="Q&A"
            subtitle="Retrieval-augmented answers over a labelled question set"
          />
          <div className="mt-3 grid gap-6 md:grid-cols-2">
            <EvalMetricChart
              title="Grounded answers"
              points={series(qa, "grounded_rate")}
            />
            <EvalMetricChart
              title="Unanswerable questions refused"
              points={series(qa, "refusal_rate")}
            />
            <EvalMetricChart
              title="Retrieval hit rate at K"
              points={series(qa, "hit_rate_at_k")}
            />
            <EvalMetricChart
              title="Citation precision"
              points={series(qa, "citation_precision_v2")}
            />
          </div>
          {questionCountChanged(qa) && (
            <p className="marginnote mt-4 text-sm">
              The question set grew between runs, so each rate is over that
              run&apos;s own questions.
            </p>
          )}
        </section>

        {lossRun && (
          <section aria-label="Net-loss base rate">
            <SectionHeader
              as="h2"
              title="Net-loss base rate"
              subtitle="Will a filer report a net loss next year? Backtested on SEC XBRL frames"
            />
            <p className="mt-2.5 max-w-[70ch] text-sm text-text">
              Each row is one filer in one year: its figures from SEC&apos;s
              annual XBRL frames, and whether it reported a net loss the year
              after. The models train on {lossRun.train_years[0]} to{" "}
              {lossRun.train_years[1]}, XGBoost stops early on{" "}
              {lossRun.validation_years[0]} to {lossRun.validation_years[1]},
              and all three are scored on {lossRun.test_years[0]} to{" "}
              {lossRun.test_years[1]}, which none of them trained on. Of the{" "}
              {formatCount(lossRun.rows.test)} test rows,{" "}
              {pct(lossRun.test_loss_rate)} reported a loss the next year.
            </p>
            <p className="mt-2.5 max-w-[70ch] text-sm text-text">
              {lossModelVerdict(lossRun)}
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full font-sans text-xs">
                <caption className="pb-1.5 text-left text-2xs text-muted">
                  Held-out years, run of {formatDate(lossRun.run_date)}. Higher
                  PR-AUC and lower Brier score are better.
                </caption>
                <thead>
                  <tr className={HEAD_ROW}>
                    <th className="py-1.5 pr-4 text-left">Model</th>
                    <th className={TH}>PR-AUC</th>
                    <th className={TH}>Brier</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {lossRun.models.map((model) => (
                    <tr key={model.name} className={BODY_ROW}>
                      <td className="whitespace-nowrap py-1.5 pr-4 text-left text-text">
                        {LOSS_MODEL_LABELS[model.name]}
                      </td>
                      <td className={TD}>{formatScore(model.pr_auc)}</td>
                      <td className={TD}>{formatScore(model.brier)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {persistence && (
              <p className="mt-3 max-w-[70ch] text-sm text-text">
                Persistence predicts next year&apos;s loss from this
                year&apos;s. In the test years a loss repeated{" "}
                {pct(persistence.lossRepeats)} of the time, and a profit turned
                into a loss {pct(persistence.profitTurns)} of the time.
              </p>
            )}
            <div className="mt-6 overflow-x-auto">
              <table className="w-full font-sans text-xs">
                <caption className="pb-1.5 text-left text-2xs text-muted">
                  Calibration: predicted against observed loss rate
                </caption>
                <thead>
                  <tr className="text-right text-2xs uppercase tracking-[0.06em] text-muted">
                    <td className="py-1.5 pr-4" />
                    <th colSpan={3} scope="colgroup" className={TH}>
                      Logistic regression
                    </th>
                    <th colSpan={3} scope="colgroup" className={TH}>
                      XGBoost
                    </th>
                  </tr>
                  <tr className={HEAD_ROW}>
                    <th className="py-1.5 pr-4 text-left">Predicted</th>
                    <th className={TH}>Rows</th>
                    <th className={TH}>Mean</th>
                    <th className={TH}>Observed</th>
                    <th className={TH}>Rows</th>
                    <th className={TH}>Mean</th>
                    <th className={TH}>Observed</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {calibrationLines(lossRun).map((line) => (
                    <tr key={line.decile} className={BODY_ROW}>
                      <th
                        scope="row"
                        className="whitespace-nowrap py-1.5 pr-4 text-left font-normal text-muted"
                      >
                        {decileRange(line.decile)}
                      </th>
                      <CalibrationCells row={line.logistic} />
                      <CalibrationCells row={line.xgboost} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="mt-4 max-w-[70ch] list-disc space-y-1.5 pl-5 text-sm text-text">
              <li>
                Frames carry each figure&apos;s latest filed value, so a later
                revision reaches back into the features. That is mild lookahead.
              </li>
              <li>
                A filer that stops filing leaves the population, so the models
                never see the companies that failed outright.
              </li>
            </ul>
            <div className="mt-3">
              <a
                href={MODEL_SOURCE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={LINK_CLASS}
              >
                <ExternalLink
                  className="h-3 w-3"
                  strokeWidth={1.5}
                  aria-hidden
                />
                Net-loss model source
              </a>
            </div>
          </section>
        )}

        <section aria-label="Runs">
          <SectionHeader
            as="h2"
            title="Runs"
          />
          <div className="mt-3 overflow-x-auto">
            <table className="w-full font-sans text-xs">
              <caption className="pb-1.5 text-left text-2xs text-muted">
                Extraction
              </caption>
              <thead>
                <tr className={HEAD_ROW}>
                  <th className="py-1.5 pr-4 text-left">Date</th>
                  <th className={`${TH} text-left`}>Model</th>
                  <th className={TH}>Filings</th>
                  <th className={TH}>Accuracy</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {newestFirst(extraction).map((run) => (
                  <tr key={run.run_date} className={BODY_ROW}>
                    <td className="whitespace-nowrap py-1.5 pr-4 text-left text-muted">
                      {formatDate(run.run_date)}
                    </td>
                    <td className={`${TD} text-left`}>{run.model}</td>
                    <td className={TD}>{run.filings}</td>
                    <td className={TD}>
                      {pct(run.accuracy)}{" "}
                      <span className="text-muted">
                        ({run.correct}/{run.scored})
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full font-sans text-xs">
              <caption className="pb-1.5 text-left text-2xs text-muted">
                Q&amp;A
              </caption>
              <thead>
                <tr className={HEAD_ROW}>
                  <th className="py-1.5 pr-4 text-left">Date</th>
                  <th className={`${TH} text-left`}>Model</th>
                  <th className={TH}>K</th>
                  <th className={TH}>Questions</th>
                  <th className={TH}>Grounded</th>
                  <th className={TH}>Refused</th>
                  <th className={TH}>Hit @K</th>
                  <th className={TH}>Citation</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {newestFirst(qa).map((run) => (
                  <tr key={run.run_date} className={BODY_ROW}>
                    <td className="whitespace-nowrap py-1.5 pr-4 text-left text-muted">
                      {formatDate(run.run_date)}
                    </td>
                    <td className={`${TD} text-left`}>{run.model}</td>
                    <td className={TD}>{run.retrieval_k}</td>
                    <td className={TD}>{run.questions}</td>
                    <td className={TD}>{pct(run.grounded_rate)}</td>
                    <td className={TD}>{pct(run.refusal_rate)}</td>
                    <td className={TD}>{pct(run.hit_rate_at_k)}</td>
                    <td className={TD}>{pct(run.citation_precision_v2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-label="Method">
          <SectionHeader
            as="h2"
            title="Method"
          />
          <p className="mt-2.5 max-w-[70ch] text-sm text-text">
            A grounded answer states no figure that is missing from its
            excerpts, other than one a single arithmetic step derives from two
            that are present. A refusal counts only when the model declines and
            invents nothing while declining. Hit rate asks whether a
            hand-labelled passage was among the K excerpts retrieved. Citation
            precision is the share of those excerpts the answer drew on. The
            build fails when grounding, refusal or extraction accuracy falls
            below its committed floor.
          </p>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
            <a
              href={`${SOURCE_URL}/scoring.py`}
              target="_blank"
              rel="noopener noreferrer"
              className={LINK_CLASS}
            >
              <ExternalLink className="h-3 w-3" strokeWidth={1.5} aria-hidden />
              Extraction scoring source
            </a>
            <a
              href={`${SOURCE_URL}/qa_scoring.py`}
              target="_blank"
              rel="noopener noreferrer"
              className={LINK_CLASS}
            >
              <ExternalLink className="h-3 w-3" strokeWidth={1.5} aria-hidden />
              Q&amp;A scoring source
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}
