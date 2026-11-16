import Script from "next/script";
import { Analytics as VercelAnalytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { UMAMI_SCRIPT_ORIGIN, UMAMI_WEBSITE_ID } from "@/lib/analytics";
import { SITE_URL } from "@/lib/site";

/** Pageviews and Core Web Vitals go to Vercel, product events to Umami.
 *
 * Vercel's scripts are served from `/_vercel/*`, which exists only on Vercel:
 * under `next start` they 404, and the console error costs `npm run lhci` its
 * best-practices score. `VERCEL` is set at build time there, and this layout is
 * prerendered, so the check is baked in.
 *
 * `data-domains` keeps previews and localhost out of the production numbers. */
export default function Analytics() {
  return (
    <>
      {process.env.VERCEL ? (
        <>
          <VercelAnalytics />
          <SpeedInsights />
        </>
      ) : null}
      {UMAMI_WEBSITE_ID ? (
        <Script
          src={`${UMAMI_SCRIPT_ORIGIN}/script.js`}
          data-website-id={UMAMI_WEBSITE_ID}
          data-domains={new URL(SITE_URL).hostname}
          data-do-not-track="true"
          strategy="afterInteractive"
        />
      ) : null}
    </>
  );
}
