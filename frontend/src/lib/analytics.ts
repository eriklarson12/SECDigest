/** Product events. Vercel's free plan records pageviews only, so named events
 * go to Umami, whose tracker `components/Analytics.tsx` loads when
 * `NEXT_PUBLIC_UMAMI_WEBSITE_ID` is set. */

export const UMAMI_WEBSITE_ID = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID || "";
export const UMAMI_SCRIPT_ORIGIN = "https://cloud.umami.is";
/** Where the tracker posts. Named for the CSP `connect-src` in `next.config.ts`. */
export const UMAMI_API_ORIGIN = "https://gateway.umami.is";

/** The whole vocabulary. An event MUST NOT carry free text a visitor typed
 * (a question, a search query): tickers and form types are public, prose is not. */
export type AnalyticsEvents = {
  company_select: { ticker: string; source: "search" | "starter" };
  analysis_start: { ticker: string; form: string };
  analysis_complete: { ticker: string; form: string; seconds: number };
  analysis_error: { ticker: string; form: string; status: number };
  ask_filing: { suggested: boolean };
  ask_company: Record<string, never>;
  watchlist_add: { ticker: string };
  watchlist_remove: { ticker: string };
  watchlist_import: { added: number };
  history_csv_export: { rows: number };
  link_copy: { label: string };
};

declare global {
  interface Window {
    umami?: { track: (event: string, data?: Record<string, unknown>) => void };
  }
}

/** Never throws and never blocks: with no tracker (unset ID, ad blocker, SSR,
 * script still loading) the event is dropped. */
export function track<E extends keyof AnalyticsEvents>(
  event: E,
  ...[data]: AnalyticsEvents[E] extends Record<string, never>
    ? []
    : [AnalyticsEvents[E]]
): void {
  if (typeof window === "undefined") return;
  try {
    window.umami?.track(event, data);
  } catch {
    // An analytics failure must not reach the action that reported it.
  }
}
