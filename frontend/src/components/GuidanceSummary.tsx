interface GuidanceSummaryProps {
  guidance: string | null;
  summary: string | null;
}

/** Prose sections. No icons, no cards — a rule and a label carry the heading,
 * and the measure is capped so the text stays readable. */
function Section({ title, body }: { title: string; body: string }) {
  return (
    <section>
      <h3 className="border-b border-text pb-1.5 font-sans text-[10px] uppercase tracking-[0.1em] text-muted">
        {title}
      </h3>
      <p className="mt-2.5 max-w-[68ch] leading-relaxed text-text">{body}</p>
    </section>
  );
}

export default function GuidanceSummary({
  guidance,
  summary,
}: GuidanceSummaryProps) {
  return (
    <div className="space-y-6">
      {summary && <Section title="Executive summary" body={summary} />}
      {guidance && <Section title="Management guidance" body={guidance} />}
    </div>
  );
}
