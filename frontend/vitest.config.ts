import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Deliberately not UTC. CI runs in UTC, which is the one zone where a
    // date parsed as UTC midnight still renders on the right calendar day —
    // so a UTC-pinned suite cannot catch that class of bug at all.
    env: { TZ: "America/New_York" },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
