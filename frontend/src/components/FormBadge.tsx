export default function FormBadge({ formType }: { formType: string }) {
  const is10K = formType.startsWith("10-K");
  return (
    <span
      className={`rounded px-2 py-0.5 font-mono text-xs font-semibold ${
        is10K ? "bg-badge-10k/15 text-badge-10k" : "bg-positive/15 text-positive"
      }`}
    >
      {formType}
    </span>
  );
}
