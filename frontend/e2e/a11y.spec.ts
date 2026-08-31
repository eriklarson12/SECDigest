import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  mockApi,
  mockBenchmarkApi,
  mockCompareApi,
  mockWatchlistApi,
  startStageServer,
} from "./mocks";

/** roadmap 5.5 — WCAG 2.1 A/AA audit of every page. Each surface waits on real
 * content before analyzing: a skeleton has almost no markup and would pass for
 * the wrong reason. */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

type Violations = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"];

/** `serious` and `critical` only — the gate this suite enforces. Each line
 * carries the rule id and the CSS path, so a failure names the fix. */
function blocking(violations: Violations): string[] {
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${v.impact} ${v.id} — ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
    );
}

type Surface = {
  name: string;
  path: string;
  setup: (page: Page) => Promise<void>;
  ready: (page: Page) => Promise<void>;
};

const SURFACES: Surface[] = [
  {
    name: "homepage",
    path: "/",
    setup: mockApi,
    ready: async (page) => {
      await expect(
        page.getByRole("link", { name: /Apple Inc\./ }),
      ).toBeVisible();
      // A fresh context has no recents, so the starter chips render here too
      await expect(
        page.getByRole("region", { name: "Suggested companies" }),
      ).toBeVisible();
    },
  },
  {
    // The starred strip only exists with a seeded watchlist, and it is the one
    // homepage region the fixture above never renders.
    name: "homepage with a starred strip",
    path: "/",
    setup: mockWatchlistApi,
    ready: async (page) => {
      await expect(
        page.getByRole("region", { name: "Starred companies" }),
      ).toContainText("New");
    },
  },
  {
    name: "analysis dashboard",
    path: "/analysis/1",
    setup: mockApi,
    ready: async (page) => {
      await expect(page.getByText("▲ 5.5% year over year")).toBeVisible();
      // Waits out the index-status poll, so the Ask card is in its ready state
      await expect(
        page.getByRole("textbox", { name: "Ask a question about this filing" }),
      ).toBeVisible();
    },
  },
  {
    name: "history",
    path: "/history",
    setup: mockApi,
    ready: async (page) => {
      await expect(page.getByRole("table")).toContainText("Apple Inc.");
    },
  },
  {
    name: "compare",
    path: "/compare?a=AAPL&b=MSFT",
    setup: mockCompareApi,
    ready: async (page) => {
      await expect(page.getByText("No analysis yet for MSFT")).toBeVisible();
      await expect(
        page.getByLabel(/Line chart comparing AAPL and MSFT/),
      ).toBeVisible();
    },
  },
  {
    name: "watchlist",
    path: "/watchlist",
    setup: mockWatchlistApi,
    ready: async (page) => {
      await expect(page.getByText("Microsoft Corporation")).toBeVisible();
      await expect(page.getByText("New filing")).toBeVisible();
    },
  },
  {
    name: "benchmark",
    path: "/benchmark",
    setup: mockBenchmarkApi,
    ready: async (page) => {
      await expect(
        page.locator("tbody tr", { hasText: "Apple Inc." }),
      ).toBeVisible();
    },
  },
  {
    // Not in the roadmap's list — /company/[ticker] landed after 5.5 was
    // written (4.2, 2026-08-11) and is a page like any other.
    name: "company page",
    path: "/company/AAPL",
    setup: mockApi,
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
      await expect(page.getByText("Past Analyses")).toBeVisible();
    },
  },
];

/** Every surface above is audited at rest. The search box is the app's only
 * composite widget, and its listbox exists only while open — the state most
 * likely to carry an ARIA defect is the one a page-load audit never sees. */
test("the open search listbox has no serious or critical accessibility violations", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");

  const box = page.getByRole("combobox");
  // goto() resolves on the server HTML; a fill landing before hydration sets
  // the value without firing onChange, so the listbox never opens.
  await expect(async () => {
    await box.fill("AAPL");
    await expect(page.getByRole("option", { name: /AAPL/ })).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 15_000 });

  const { violations } = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .analyze();

  expect(blocking(violations)).toEqual([]);
});

/** roadmap 5.3's stage checklist. Same reason as the listbox above: it exists
 * only while an analysis is running, so no page-load audit can ever reach it. */
test("the streaming stage checklist has no serious or critical accessibility violations", async ({
  page,
}) => {
  await mockApi(page);
  // The stream stops at `fetching_filing` and stays open, so the checklist is on
  // screen for the whole audit no matter how long axe takes on a loaded machine.
  const sse = await startStageServer(0, "fetching_filing");
  await page.route("**/api/analysis", (route) =>
    route.request().method() === "POST"
      ? route.continue({ url: sse.url })
      : route.fallback(),
  );

  try {
    await page.goto("/");
    await expect(async () => {
      await page.getByRole("combobox").fill("AAPL");
      await expect(page.getByRole("option", { name: /AAPL/ })).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 15_000 });
    await page.getByRole("option", { name: /AAPL/ }).click();
    await page.getByRole("button", { name: "Analyze" }).click();
    await expect(page.getByText("Fetching the filing from EDGAR")).toBeVisible();

    const { violations } = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .analyze();

    expect(blocking(violations)).toEqual([]);
  } finally {
    await sse.close();
  }
});

for (const surface of SURFACES) {
  test(`${surface.name} has no serious or critical accessibility violations`, async ({
    page,
  }) => {
    await surface.setup(page);
    await page.goto(surface.path);
    await surface.ready(page);

    const { violations } = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .analyze();

    expect(blocking(violations)).toEqual([]);
  });
}
