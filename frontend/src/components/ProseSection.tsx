import SectionHeader from "./SectionHeader";

/** A prose section: no icon, no card. A rule and a label carry the heading, and the measure
 * stays readable. */
export default function ProseSection({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <section>
      <SectionHeader title={title} />
      <p className="mt-2.5 leading-relaxed text-text">{body}</p>
    </section>
  );
}
