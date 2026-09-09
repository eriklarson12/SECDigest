import SectionHeader from "./SectionHeader";

interface GuidanceSummaryProps {
  guidance: string | null;
  summary: string | null;
}

/** Prose sections. No icons, no cards — a rule and a label carry the heading,
 * and the measure is capped so the text stays readable. */
function Section({ title, body }: { title: string; body: string }) {
  return (
    <section>
      <SectionHeader title={title} />
      <p className="mt-2.5 leading-relaxed text-text">{body}</p>
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
