/** Outlined label, no fill, no hue — the text already reads "10-K" / "10-Q",
 * so colour was redundant encoding (docs/design-system.md §6.2). */
export default function FormBadge({ formType }: { formType: string }) {
  return (
    <span
      data-testid="form-badge"
      className="whitespace-nowrap border border-border px-1.5 py-px font-sans text-[10px] tracking-[0.06em] text-muted"
    >
      {formType}
    </span>
  );
}
