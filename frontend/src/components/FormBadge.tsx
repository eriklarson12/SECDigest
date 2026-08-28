/** Outlined label, no fill, no hue. The annual/quarterly split is carried by
 * weight — ink for 10-K, muted for 10-Q — because one differing character at
 * this size is not a scannable difference (docs/design-system.md §6.2). */
export default function FormBadge({ formType }: { formType: string }) {
  const annual = formType.startsWith("10-K");
  return (
    <span
      data-testid="form-badge"
      className={`whitespace-nowrap border px-1.5 py-0.5 font-sans text-2xs tracking-[0.06em] ${
        annual ? "border-text font-medium text-text" : "border-muted text-muted"
      }`}
    >
      {formType}
    </span>
  );
}
