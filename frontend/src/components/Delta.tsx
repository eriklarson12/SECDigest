import { formatPercent } from "@/lib/format";

interface DeltaProps {
  value: number | null | undefined;
  /** Trailing words, e.g. "year over year". Omitted where the column header says it. */
  suffix?: string;
  className?: string;
}

/** A year-over-year change. Glyph + sign accompany the colour — never colour
 * alone. With two hues in the palette the glyph carries most of the signal. */
export default function Delta({ value, suffix, className = "" }: DeltaProps) {
  if (value == null) return null;

  const isPositive = value >= 0;

  return (
    <span
      className={`font-sans tabular-nums ${
        isPositive ? "text-accent" : "text-primary"
      } ${className}`}
    >
      {isPositive ? "▲" : "▼"} {formatPercent(Math.abs(value))}
      {suffix ? ` ${suffix}` : ""}
    </span>
  );
}
