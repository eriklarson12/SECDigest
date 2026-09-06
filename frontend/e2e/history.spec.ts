import fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { ANALYSIS } from "./mocks";

/** 25 stored analyses — one page of 20 plus a short tail. The first 22 share the
 * fixture's SIC; the tail carries a second one, so a SIC filter narrows to a page
 * short enough that "Load more" must disappear if the filter reached the server. */
const OTHER_SIC = {
  sic: "7372",
  sic_description: "Prepackaged Software",
  owner_org: "07 Trade & Services",
};

const ALL_ROWS = Array.from({ length: 25 }, (_, i) => ({
  ...ANALYSIS,
  id: i + 1,
  accession_number: `00003201932600${String(i).padStart(4, "0")}`,
  ticker: `T${i + 1}`,
  company_name: `Test Company ${i + 1}`,
  ...(i >= 22 ? OTHER_SIC : {}),
  // Two rows EDGAR never classified, so the unclassified bucket has something in it.
  ...(i === 20 || i === 21 ? { owner_org: null } : {}),
  // A comma inside a risk factor exercises CSV quoting
  risk_factors: ["Regulatory, litigation and tax risks."],
}));

/** The corpus by review office, derived from the rows the list route serves rather than
 * hard-coded: a picker count and the filtered page it leads to then cannot disagree.
 * Deliberately left in row order, since ordering is `compareSectors`' job. */
const SECTOR_COUNTS = (() => {
  const counts = new Map<string | null, number>();
  for (const row of ALL_ROWS) {
    const key = row.owner_org || null;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([owner_org, count]) => ({ owner_org, count }));
})();

async function mockPagedList(page: Page) {
  // Its own pattern: Playwright's glob escapes `?` to a literal, so the route below
  // needs a real query string and never matches /api/analysis/sectors.
  await page.route("**/api/analysis/sectors", (route) =>
    route.fulfill({ json: { sectors: SECTOR_COUNTS } }),
  );
  await page.route("**/api/analysis?*", async (route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const ticker = url.searchParams.get("ticker");
    const sic = url.searchParams.get("sic");
    const ownerOrg = url.searchParams.get("owner_org");
    let rows = ALL_ROWS;
    if (ticker) rows = rows.filter((r) => r.ticker === ticker);
    if (sic) rows = rows.filter((r) => r.sic === sic);
    if (ownerOrg === "unclassified") rows = rows.filter((r) => !r.owner_org);
    else if (ownerOrg) rows = rows.filter((r) => r.owner_org === ownerOrg);
    await route.fulfill({
      json: {
        analyses: rows.slice(offset, offset + limit),
        total: rows.length,
      },
    });
  });
}

test("history paginates with Load more", async ({ page }) => {
  await mockPagedList(page);
  await page.goto("/history");

  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "T20", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "T21", exact: true }),
  ).toBeHidden();
  const loadMore = page.getByRole("button", { name: "Load more" });
  await expect(loadMore).toBeVisible();

  // Appends the tail, then disappears (short page = end of data)
  await loadMore.click();
  await expect(
    page.getByRole("link", { name: "T25", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();
  await expect(loadMore).toBeHidden();
});

test("CSV export downloads all loaded rows with quoting intact", async ({
  page,
}) => {
  await mockPagedList(page);
  await page.goto("/history");
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloadPromise;
  const content = fs.readFileSync(await download.path(), "utf-8");

  expect(
    content.startsWith(
      "ticker,company_name,sic,sic_description,owner_org,form_type,",
    ),
  ).toBe(true);
  // The sector the export was filtered by has to survive into the file.
  expect(content).toContain("3571,Electronic Computers,06 Technology");
  expect(content).toContain('"Regulatory, litigation and tax risks."');
  // All 20 loaded rows exported (header + 20 rows, trailing newline)
  expect(content.trim().split("\r\n")).toHaveLength(21);
});

test("filters history by ticker", async ({ page }) => {
  await mockPagedList(page);
  await page.goto("/history");
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();

  const filterInput = page.getByLabel("Filter history by ticker");
  await filterInput.fill("T3");
  await filterInput.press("Enter");

  await expect(
    page.getByRole("link", { name: "T3", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeHidden();
  await expect(page.getByRole("button", { name: "Load more" })).toBeHidden();

  await filterInput.fill("");
  await filterInput.press("Enter");

  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
});

test("empty filter result shows Clear filter", async ({ page }) => {
  await mockPagedList(page);
  await page.goto("/history");
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();

  const filterInput = page.getByLabel("Filter history by ticker");
  await filterInput.fill("ZZZZ");
  await filterInput.press("Enter");

  await expect(page.getByText("No analyses for ZZZZ")).toBeVisible();
  const clearButton = page.getByRole("button", { name: "Clear filter" });
  await expect(clearButton).toBeVisible();

  await clearButton.click();
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();
});

// --- Industry filter (roadmap 8.2) ---

test("?sic= filters the list, names the filter, and counts the matches", async ({
  page,
}) => {
  await mockPagedList(page);
  await page.goto("/history?sic=7372");

  await expect(
    page.getByRole("link", { name: "T23", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeHidden();

  // The label comes from the returned rows, not from the URL, which carries only the code
  await expect(page.getByTestId("active-sic-filter")).toContainText(
    "Filtered to SIC 7372 · Prepackaged Software",
  );
  await expect(page.getByTestId("filter-count")).toHaveText("3 analyses");
  await expect(page.getByRole("button", { name: "Load more" })).toBeHidden();
});

test("Load more keeps the industry filter", async ({ page }) => {
  await mockPagedList(page);
  await page.goto("/history?sic=3571");

  await expect(page.getByTestId("filter-count")).toHaveText("22 analyses");
  await page.getByRole("button", { name: "Load more" }).click();

  // Page two of the filtered set, not of the corpus: T23 belongs to the other SIC
  await expect(
    page.getByRole("link", { name: "T22", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "T23", exact: true }),
  ).toBeHidden();
});

test("clearing the industry filter drops the param and restores page one", async ({
  page,
}) => {
  await mockPagedList(page);
  await page.goto("/history?sic=7372");
  await expect(page.getByTestId("active-sic-filter")).toBeVisible();

  await page
    .getByTestId("active-sic-filter")
    .getByRole("button", { name: "Clear" })
    .click();

  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("active-sic-filter")).toBeHidden();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
});

/** Roadmap 8.5 — arrives from the homepage's sector line. */
test("?owner_org= filters the list and names the office from the rows", async ({
  page,
}) => {
  await mockPagedList(page);
  await page.goto("/history?owner_org=07%20Trade%20%26%20Services");

  await expect(
    page.getByRole("link", { name: "T23", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeHidden();
  // The office number is a sort key, not part of the name.
  await expect(page.getByTestId("active-sector-filter")).toContainText(
    "Filtered to Trade & Services",
  );
  await expect(page.getByTestId("filter-count")).toHaveText("3 analyses");
  await expect(page.getByRole("button", { name: "Load more" })).toBeHidden();
});

test("the unclassified sentinel filters to the rows EDGAR never classified", async ({
  page,
}) => {
  await mockPagedList(page);
  await page.goto("/history?owner_org=unclassified");

  await expect(
    page.getByRole("link", { name: "T21", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeHidden();
  // Those rows carry no office to read a name off, so the label is the app's own word.
  await expect(page.getByTestId("active-sector-filter")).toContainText(
    "Filtered to Unclassified",
  );
  await expect(page.getByTestId("filter-count")).toHaveText("2 analyses");
});

/** Both filters live in the URL, and each Clear must drop only its own param —
 * navigating to a bare /history would silently clear the other one too. */
test("clearing one URL filter leaves the other in place", async ({ page }) => {
  await mockPagedList(page);
  await page.goto("/history?sic=7372&owner_org=07%20Trade%20%26%20Services");
  await expect(page.getByTestId("active-sic-filter")).toBeVisible();
  await expect(page.getByTestId("active-sector-filter")).toBeVisible();

  await page
    .getByTestId("active-sector-filter")
    .getByRole("button", { name: "Clear" })
    .click();

  await expect(page.getByTestId("active-sector-filter")).toBeHidden();
  await expect(page.getByTestId("active-sic-filter")).toBeVisible();
  await expect(page).toHaveURL("/history?sic=7372");

  await page
    .getByTestId("active-sic-filter")
    .getByRole("button", { name: "Clear" })
    .click();

  await expect(page.getByTestId("active-sic-filter")).toBeHidden();
  await expect(page).toHaveURL(/\/history$/);
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();
});

/** Roadmap 8.6. 8.5 made the sector reachable only from the homepage, so a filtered
 * history was a dead end — Clear was the page's one control. */
test("the sector picker lists the corpus in office order, with All first", async ({
  page,
}) => {
  await mockPagedList(page);
  await page.goto("/history");

  await expect(page.getByTestId("sector-picker")).toHaveText(
    "All 25 · Technology 20 · Trade & Services 3 · Unclassified 2",
  );
  // Nothing is filtered, so All is the current page.
  await expect(
    page.getByRole("link", { name: "All", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

test("picking a sector filters the rows and marks itself current", async ({
  page,
}) => {
  await mockPagedList(page);
  await page.goto("/history");

  await page
    .getByRole("link", { name: "Trade & Services", exact: true })
    .click();

  // The raw EDGAR value travels in the URL; the label drops the office number.
  await expect(page).toHaveURL(/owner_org=/);
  expect(new URL(page.url()).searchParams.get("owner_org")).toBe(
    "07 Trade & Services",
  );
  await expect(
    page.getByRole("link", { name: "T23", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeHidden();
  await expect(page.getByTestId("filter-count")).toHaveText("3 analyses");
  await expect(
    page.getByRole("link", { name: "Trade & Services", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  // The counts stay corpus-wide, which is what makes the picker a way out.
  await expect(page.getByTestId("sector-picker")).toContainText(
    "Technology 20",
  );
  await expect(
    page.getByRole("link", { name: "Technology", exact: true }),
  ).not.toHaveAttribute("aria-current", "page");
});

test("the picker opens the unclassified bucket", async ({ page }) => {
  await mockPagedList(page);
  await page.goto("/history");

  await page.getByRole("link", { name: "Unclassified", exact: true }).click();

  await expect(page).toHaveURL(/owner_org=/);
  expect(new URL(page.url()).searchParams.get("owner_org")).toBe(
    "unclassified",
  );
  await expect(
    page.getByRole("link", { name: "T21", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("filter-count")).toHaveText("2 analyses");
});

/** The set path of the bug 8.5 fixed on the clear path: rewriting one param must not
 * take the other with it. */
test("All clears the sector and leaves an active industry filter standing", async ({
  page,
}) => {
  await mockPagedList(page);
  await page.goto("/history?sic=3571&owner_org=unclassified");
  await expect(page.getByTestId("filter-count")).toHaveText("2 analyses");

  await page.getByRole("link", { name: "All", exact: true }).click();

  await expect(page).toHaveURL("/history?sic=3571");
  await expect(page.getByTestId("active-sic-filter")).toBeVisible();
  await expect(page.getByTestId("active-sector-filter")).toBeHidden();
  await expect(page.getByTestId("filter-count")).toHaveText("22 analyses");
});

test("a failing sectors call costs the picker and not the rows", async ({
  page,
}) => {
  await mockPagedList(page);
  // Registered after mockPagedList's own sectors route, so this one wins.
  await page.route("**/api/analysis/sectors", (route) =>
    route.fulfill({ status: 500, json: { detail: "boom" } }),
  );
  await page.goto("/history");

  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
  await expect(page.getByTestId("sector-picker")).toBeHidden();
});

/** The picker sits above the table, so it must arrive in the same commit as the rows —
 * landing later would push a painted table down. Lighthouse cannot catch that: its job
 * measures /history with no backend, where the sectors call fails and the picker never
 * renders at all. CPU throttling is what makes the shift observable; an unthrottled
 * browser commits both renders inside one frame. */
test("the history page does not shift after first paint", async ({ page }) => {
  await mockPagedList(page);
  // The aggregate must answer *after* the rows, or the picker lands first and there is
  // nothing painted for it to displace — against which the regression passes.
  await page.route("**/api/analysis/sectors", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ json: { sectors: SECTOR_COUNTS } });
  });
  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
        };
        if (!shift.hadRecentInput)
          (window as unknown as { __cls: number }).__cls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 8 });

  await page.goto("/history");
  // Sampling before both land would miss the shift this test exists for.
  await expect(page.getByTestId("sector-picker")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "T20", exact: true }),
  ).toBeVisible();

  const cls = await page.evaluate(
    () => (window as unknown as { __cls: number }).__cls,
  );
  expect(cls).toBeLessThan(0.01);
});

test("an unmatched industry code shows the empty state, not an error", async ({
  page,
}) => {
  await mockPagedList(page);
  await page.goto("/history?sic=9999");

  await expect(page.getByText("No analyses for SIC 9999")).toBeVisible();
  await expect(page.getByTestId("filter-count")).toHaveText("0 analyses");
  await expect(page.getByRole("button", { name: "Retry" })).toBeHidden();

  await page.getByRole("button", { name: "Clear filter" }).click();
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();
});

test("a junk sic param degrades to the unfiltered page", async ({ page }) => {
  await mockPagedList(page);
  await page.goto("/history?sic=not-a-code");

  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("active-sic-filter")).toBeHidden();
});

test("the ticker filter and the industry filter combine", async ({ page }) => {
  await mockPagedList(page);
  await page.goto("/history?sic=3571");
  await expect(page.getByTestId("filter-count")).toHaveText("22 analyses");

  const filterInput = page.getByLabel("Filter history by ticker");
  await filterInput.fill("T23");
  await filterInput.press("Enter");

  // T23 exists but sits in the other SIC, so the AND is empty
  await expect(
    page.getByText("No analyses for T23 · SIC 3571 · Electronic Computers"),
  ).toBeVisible();
});

test("the active filter line does not overflow a 375px viewport", async ({
  page,
}) => {
  await page.route("**/api/analysis?*", (route) =>
    route.fulfill({
      json: {
        analyses: [
          {
            ...ALL_ROWS[0],
            sic: "7372",
            // One of the longest descriptions EDGAR issues.
            sic_description:
              "Services-Computer Programming, Data Processing, Etc.",
          },
        ],
        total: 1,
      },
    }),
  );
  // The picker wraps to three lines at this width, which is why it is inline text and
  // not chips. Routed here so the suite makes no unmocked request.
  await page.route("**/api/analysis/sectors", (route) =>
    route.fulfill({
      json: {
        sectors: [
          // The longest office EDGAR issues, next to the longest unnumbered one.
          { owner_org: "05 Industrial Applications and Services", count: 4 },
          { owner_org: "International Corp Fin", count: 2 },
          { owner_org: null, count: 1 },
        ],
      },
    }),
  );
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/history?sic=7372");

  await expect(page.getByTestId("active-sic-filter")).toBeVisible();
  await expect(page.getByTestId("sector-picker")).toBeVisible();
  await expect(page.getByTestId("filter-count")).toHaveText("1 analysis");
  const scrollWidth = await page.evaluate(
    () => document.documentElement.scrollWidth,
  );
  expect(scrollWidth).toBeLessThanOrEqual(375);
});
