/** The page's ending: where a digest comes from, and what in it is exact.
 *
 * Static by design — it is the one thing below the search box that a visitor
 * with no history and an empty corpus still sees, so it must not depend on a
 * request. Steps track the real pipeline in backend/app/routers/analysis.py;
 * the model is named without a version because config.py carries a fallback
 * and a separate Q&A model, so any single version would be wrong some of the
 * time. */

const STEPS = [
  {
    title: "Fetch:",
    body: "The filing document comes straight from SEC EDGAR, through a throttled client that identifies itself.",
  },
  {
    title: "Target:",
    body: "Filings run long. Risk Factors and MD&A are located and kept first when one is too large to send whole.",
  },
  {
    title: "Extract:",
    body: "A Gemini model reads the kept sections and returns figures, risks, guidance, and a summary. One analysis per filing, stored and reused.",
  },
  {
    title: "Verify:",
    body: "Trends are drawn from as-reported SEC XBRL company facts, not from the model.",
  },
];

export default function HowItWorks() {
  return (
    <section className="mt-12 w-full" aria-label="How it works">
      <h2 className="border-b border-text pb-1.5 font-sans text-xs font-semibold uppercase tracking-[0.07em] text-text">
        How it works
      </h2>
      <ol className="mt-3">
        {STEPS.map((step, i) => (
          <li
            key={step.title}
            className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-baseline gap-x-2 py-1.5"
          >
            <span
              aria-hidden
              className="font-sans text-2xs tabular-nums text-muted"
            >
              {i + 1}
            </span>
            <p className="text-sm text-text">
              <span className="font-sans font-semibold">{step.title}</span>
              {` ${step.body}`}
            </p>
          </li>
        ))}
      </ol>
      <p className="mt-3 max-w-[91ch] text-sm text-muted">
        Data from SEC EDGAR. Extracted figures and summaries are model-generated and can be wrong — not investment advice.
      </p>
    </section>
  );
}
