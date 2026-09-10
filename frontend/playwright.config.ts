import { defineConfig } from "@playwright/test";

// Dedicated port: 3000 is often occupied by another dev server, and
// reuseExistingServer would otherwise run the tests against the wrong app.
const PORT = 3100;

// CI builds+starts a production server; `next dev`'s on-demand compilation adds
// multi-second first-hit latency on shared runners that flakes tight-timeout assertions.
const command = process.env.CI
  ? `npm run build && npm run start -- -p ${PORT}`
  : `npm run dev -- -p ${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    // CI builds and starts a production server, which is where the service
    // worker registers. Every spec mocks the backend with page.route, and
    // Playwright does not intercept fetches a worker issues itself, so a live
    // worker would send those requests to the real network. pwa.spec.ts opts
    // back in with test.use.
    serviceWorkers: "block",
    // Negative offset on purpose — see the note in vitest.config.ts.
    timezoneId: "America/New_York",
  },
  webServer: {
    command,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
