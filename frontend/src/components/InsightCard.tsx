import { formatCurrency, formatPercent } from "@/lib/format";
import Delta from "./Delta";

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

  return (
    <div>
      <p className="font-sans text-2xs uppercase tracking-[0.08em] text-muted">
        {label}
      </p>
      <p className="mt-1 text-4xl tabular-nums leading-none text-text">
        {displayValue}
      </p>
      <Delta
        value={changePercent}
        suffix="year over year"
        className="mt-1.5 block text-xs"
      />
    </div>
  );
}
