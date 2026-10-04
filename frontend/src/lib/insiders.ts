import { formatCurrency, formatShareCount } from "./format";
import type { InsiderActivity, InsiderTransaction } from "./types";

/** Insider activity copy (roadmap 12.5). Pure, so every sentence the strip shows is tested. */

export const MAX_INSIDER_ROWS = 5;

export function codeLabel(code: InsiderTransaction["code"]): string {
  return code === "P" ? "Buy" : "Sale";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The 90-day net, read with its arrow: "▼ Net sold 13,430 shares ($4.3M)". No direction
 * colour: net selling has a direction but no goodness (the `Revisions` rule). */
export function netLine(activity: InsiderActivity): string {
  const { net_shares: shares, net_value: value } = activity;
  if (shares === 0) return "Buys and sells net to zero shares";
  const verb = shares > 0 ? "▲ Net bought" : "▼ Net sold";
  const dollars = value !== 0 ? ` (${formatCurrency(Math.round(Math.abs(value)))})` : "";
  const noun = Math.round(Math.abs(shares)) === 1 ? "share" : "shares";
  return `${verb} ${formatShareCount(shares)} ${noun}${dollars}`;
}

/** "8 of 8 trades were scheduled under a 10b5-1 plan", or null when none were. */
export function plannedLine(activity: InsiderActivity): string | null {
  const total = activity.transactions.length;
  const planned = activity.transactions.filter((t) => t.planned).length;
  if (planned === 0) return null;
  return `${planned} of ${plural(total, "trade", "trades")} ${planned === 1 ? "was" : "were"} scheduled in advance under a Rule 10b5-1 plan.`;
}

/** What the figure covers, and what it could not. */
export function sourceLine(activity: InsiderActivity): string {
  const parts = [
    `From the ${plural(activity.filings_scanned, "Form 4", "Form 4s")} filed in the last ${activity.window_days} days. Open-market trades only.`,
  ];
  if (activity.truncated) parts.push("Only the latest filings were read, so older ones may be missing.");
  if (activity.filings_failed > 0) {
    parts.push(`${plural(activity.filings_failed, "filing", "filings")} could not be read.`);
  }
  if (activity.unpriced_count > 0) {
    parts.push(`The dollar figure leaves out ${plural(activity.unpriced_count, "trade", "trades")} filed without a price.`);
  }
  return parts.join(" ");
}

/** The line shown when there is no trade to list. A count, never a verdict on the company. */
export function emptyLine(activity: InsiderActivity): string {
  if (activity.filings_scanned === 0) {
    return `No Form 4s filed in the last ${activity.window_days} days.`;
  }
  const others = activity.filings_without_trades;
  const tail =
    others > 0
      ? ` ${plural(others, "Form 4", "Form 4s")} reported other transactions, such as grants, option exercises or tax withholding.`
      : "";
  return `No open-market buys or sells in the last ${activity.window_days} days.${tail}`;
}
