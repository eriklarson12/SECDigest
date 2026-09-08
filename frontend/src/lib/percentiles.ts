/** Presentation rules for population percentiles (roadmap 9.4).
 *
 * Kept out of the component for the same reason `lib/revisions.ts` is: Vitest here runs in a node
 * environment against `.test.ts` files only, with no jsdom and no React testing library. The
 * rendered states are Playwright's.
 *
 * Metric labels are NOT redefined here — `metricLabel` in `lib/revisions.ts` already maps these
 * exact three keys, and a second map would drift from it. */

import type { Percentile } from "./types";

const ORDINALS: Record<number, string> = { 1: "st", 2: "nd", 3: "rd" };

/** "99.9th", "1st", "23rd", "12th". One decimal, because the top of a 5,600-filer population is
 * crowded: Apple and Microsoft both round to the 100th without it. */
export function formatPercentile(pct: number): string {
  const rounded = Number(pct.toFixed(1));
  const whole = Math.floor(rounded);
  // An ordinal suffix belongs to a whole number. Reading the integer part's last digit through a
  // decimal produces "93.2rd", which QSR's real ranking rendered.
  if (rounded !== whole) return `${rounded}th`;
  // 11th, 12th and 13th take "th" despite ending in 1, 2 and 3.
  const teen = whole % 100 >= 11 && whole % 100 <= 13;
  const suffix = teen ? "th" : (ORDINALS[whole % 10] ?? "th");
  return `${whole}${suffix}`;
}

/** Bar width as a percentage, floored so the bottom of the population still draws something.
 * A bar that vanishes reads as missing data rather than as a low rank. */
export function percentileBarWidth(pct: number): number {
  return Math.min(100, Math.max(2, pct));
}

/** The entry for one metric, or null. Order is not assumed: the backend omits a metric this
 * filer never tagged, so position carries no meaning. */
export function findPercentile(
  percentiles: Percentile[],
  metric: string,
): Percentile | null {
  return percentiles.find((p) => p.metric === metric) ?? null;
}
