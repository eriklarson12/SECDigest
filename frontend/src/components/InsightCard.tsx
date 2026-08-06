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
  const isNegative = changePercent != null && changePercent < 0;

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </p>
      <p className="mt-1 font-mono text-3xl font-semibold tabular-nums text-text">
        {displayValue}
      </p>
      {changePercent != null && (
        <div className="mt-2 flex items-center gap-1">
          {/* Glyph + sign accompany the color — never color alone */}
          <span
            className={`font-mono text-sm font-semibold tabular-nums ${
              isPositive
                ? "text-positive"
                : isNegative
                  ? "text-negative"
                  : "text-muted"
            }`}
          >
            {isPositive ? "▲" : "▼"} {Math.abs(changePercent).toFixed(1)}%
          </span>
          <span className="text-xs text-muted">YoY</span>
        </div>
      )}
    </div>
  );
}
