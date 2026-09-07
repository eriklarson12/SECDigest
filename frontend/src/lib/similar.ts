/** Language peers (roadmap 9.1) — everything the card decides, kept out of the component so
 * it can be tested. Vitest here runs in a node environment against `.test.ts` files only, so a
 * rendered component is Playwright's job and this is the unit-testable half. */

import { formatIndustry } from "./format";
import type { SimilarFiling, SimilarFilingsResponse } from "./types";

/** Below this the card shows its empty state rather than a short list. A ranking of one or two
 * reads as a claim about a company's nearest peers; drawn from a pool that small it is not one. */
export const MIN_POOL = 3;

export interface SimilarRow {
  analysisId: number;
  ticker: string;
  companyName: string;
  formType: string;
  /** "SIC 3674 · Semiconductors & Related Devices", or null for an unclassified filer. */
  industry: string | null;
  /** True only when both codes are known and differ. A missing code is not evidence of a
   * difference, so it reads false — this flag is a claim, not a default. */
  differentIndustry: boolean;
}

export type SimilarState =
  | { kind: "unavailable" }
  | { kind: "too-small" }
  | { kind: "ready"; rows: SimilarRow[]; pool: number };

function toRow(peer: SimilarFiling, subjectSic: string | null): SimilarRow {
  return {
    analysisId: peer.analysis_id,
    ticker: peer.ticker,
    companyName: peer.company_name,
    formType: peer.form_type,
    industry: formatIndustry(peer.sic, peer.sic_description),
    differentIndustry: Boolean(subjectSic && peer.sic && peer.sic !== subjectSic),
  };
}

/** The card's three states, decided in one place.
 *
 * Order matters: "we cannot place this filing" is a different answer from "there is not enough
 * corpus to place it against", and both are different from an empty result. */
export function similarState(
  data: SimilarFilingsResponse,
  subjectSic: string | null,
): SimilarState {
  if (!data.available) return { kind: "unavailable" };
  if (data.pool < MIN_POOL || data.peers.length === 0) return { kind: "too-small" };
  return {
    kind: "ready",
    rows: data.peers.map((peer) => toRow(peer, subjectSic)),
    pool: data.pool,
  };
}

/** Names the pool the ranking actually drew from. The honest-framing rule: this is the corpus
 * analyzed here, not EDGAR, and the caption has to say so and say how big it is. */
export function poolCaption(pool: number): string {
  return `Nearest of ${pool} other ${pool === 1 ? "company" : "companies"} analyzed here`;
}

/** Seeds /benchmark with this exact set.
 *
 * `?only=` and not `?add=`: the benchmark page seeds the watchlist first and caps at ten rows,
 * so `?add=` silently drops every peer for anyone with a full watchlist — the button would then
 * show a different set than it named. `?peers=` is wrong for the opposite reason: it is a SIC
 * lookup, which is the classification this feature exists to second-guess. */
export function benchmarkHref(subjectTicker: string, rows: SimilarRow[]): string {
  const tickers = [subjectTicker, ...rows.map((r) => r.ticker)].map((t) =>
    t.trim().toUpperCase(),
  );
  const unique = [...new Set(tickers)].filter(Boolean);
  // Raw commas, as `?add=` and `?peers=` already write them: TICKER_RE admits only URL-safe
  // characters, and an escaped separator would make a shareable link unreadable for nothing.
  return `/benchmark?only=${unique.join(",")}`;
}
