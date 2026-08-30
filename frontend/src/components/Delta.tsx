import { formatPercent } from "@/lib/format";

interface DeltaProps {
  value: number | null | undefined;
  /** Trailing words, e.g. "year over year". Omitted where the column header says it. */
  suffix?: string;
  className?: string;
}

/** A year-over-year change. Glyph + sign accompany the colour — never colour
 * alone. positive/negative are direction status, not data colours: they live
 * here and MUST NOT be reused for a series or a company (docs/design-system.md). */
export default function Delta({ value, suffix, className = "" }: DeltaProps) {
  if (value == null) return null;

  const isPositive = value >= 0;

  return (
    <span
      className={`font-sans tabular-nums ${
        isPositive ? "text-positive" : "text-negative"
      } ${className}`}
    >
      {isPositive ? "▲" : "▼"} {formatPercent(Math.abs(value))}
      {suffix ? ` ${suffix}` : ""}
    </span>
  );
}
