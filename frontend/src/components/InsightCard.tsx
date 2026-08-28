import { formatCurrency, formatPercent } from "@/lib/format";

interface InsightCardProps {
  label: string;
  value: number | null;
  format?: "currency" | "percent";
  changePercent?: number | null;
}

export default function InsightCard({
  label,
  value,
  format = "currency",
  changePercent,
}: InsightCardProps) {
  const displayValue =
    format === "currency" ? formatCurrency(value) : formatPercent(value);

  const isPositive = changePercent != null && changePercent >= 0;

  return (
    <div>
      <p className="font-sans text-2xs uppercase tracking-[0.08em] text-muted">
        {label}
      </p>
      <p className="mt-1 text-4xl tabular-nums leading-none text-text">
        {displayValue}
      </p>
      {changePercent != null && (
        /* Glyph + sign accompany the colour — never colour alone. With two
           hues in the palette the glyph carries most of the signal. */
        <p
          className={`mt-1.5 font-sans text-xs tabular-nums ${
            isPositive ? "text-accent" : "text-primary"
          }`}
        >
          {isPositive ? "▲" : "▼"} {Math.abs(changePercent).toFixed(1)}% year
          over year
        </p>
      )}
    </div>
  );
}
