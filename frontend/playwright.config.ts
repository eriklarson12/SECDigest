import { defineConfig } from "@playwright/test";

// Dedicated port: 3000 is often occupied by another dev server, and
// reuseExistingServer would otherwise run the tests against the wrong app.
const PORT = 3100;

// CI runs against a production build: `next dev`'s on-demand compilation is
// fast locally but adds multi-second first-hit latency on shared CI runners,
// which flakes assertions with tight timeouts. Local dev keeps `next dev` +
// reuseExistingServer for fast iteration.
const command = process.env.CI
  ? `npm run build && npm run start -- -p ${PORT}`
  : `npm run dev -- -p ${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
