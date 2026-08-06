import { defineConfig } from "@playwright/test";

// Dedicated port: 3000 is often occupied by another dev server, and
// reuseExistingServer would otherwise run the tests against the wrong app.
const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
