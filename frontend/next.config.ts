import type { NextConfig } from "next";

// The API origin must be allowed in connect-src; derived from the same env
// var the client uses so the two can't drift.
const apiOrigin = new URL(
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api",
).origin;

// 'unsafe-inline' is required by Next's hydration bootstrap (no nonces); 'unsafe-eval'
// is dev-only (HMR). External script injection is still blocked.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${apiOrigin}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  experimental: {
    // Powers `useOffline` in components/OfflineBanner.tsx, and retries
    // navigations and prefetches that were blocked while offline. Flagged
    // experimental by Next 16.3: the banner is the only thing that reads it,
    // so a removal is a one-component fix.
    useOffline: true,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // A cached service worker is a permanently stale deploy: the browser
        // would keep re-registering the old script, which keeps serving the old
        // precache. Next's PWA guide also suggests a tighter CSP here, which
        // this deliberately omits -- the worker fetches the API, and the global
        // connect-src above is what allows that origin.
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
