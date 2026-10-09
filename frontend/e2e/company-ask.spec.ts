import { test, expect, type Page } from "@playwright/test";
import { mockApi, ASK_SCOPE_SINGLE, COMPANY_ASK_ANSWER } from "./mocks";

/** "Ask across filings" — the company page's cross-filing Q&A (roadmap 13.2). */

const ASK_INPUT = { name: "Ask a question across this company's filings" };

/** Same hydration race as ask.spec.ts: a fill() before React hydrates never reaches state. */
async function typeQuestion(page: Page, question: string) {
  const input = page.getByRole("textbox", ASK_INPUT);
  const button = page.getByRole("button", { name: "Ask", exact: true });
  await expect(async () => {
    await input.fill(question);
    await expect(button).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  return button;
}

function panel(page: Page) {
  return page.getByRole("region", { name: "Ask across filings" });
}

test("an answer across two filings links each citation to its filing", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/company/AAPL");

  await expect(panel(page)).toContainText(
    "10-K filed Oct 31, 2025 · 10-K filed Nov 1, 2024",
  );
  await (
    await typeQuestion(page, "How did Greater China net sales change?")
  ).click();

  const first = panel(page).getByRole("link", {
    name: "Excerpt 1, from the 10-K filed Oct 31, 2025",
  });
  const second = panel(page).getByRole("link", {
    name: "Excerpt 2, from the 10-K filed Nov 1, 2024",
  });
  await expect(first).toHaveAttribute("href", "/analysis/1");
  await expect(second).toHaveAttribute("href", "/analysis/2");
  // "9" has no source, so it stays text rather than becoming a dead link.
  await expect(
    panel(page).getByRole("link", { name: /^Excerpt 9/ }),
  ).toHaveCount(0);
  await expect(panel(page)).toContainText("(excerpts 2, 9)");

  await panel(page).getByText("Sources (2)").click();
  await expect(
    panel(page).getByText("Figures as filed: Amounts in millions."),
  ).toBeVisible();
  await expect(
    panel(page).getByText(COMPANY_ASK_ANSWER.sources[1]!.excerpt, {
      exact: false,
    }),
  ).toBeVisible();
});

test("a single indexed filing points to its own ask", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/companies/*/ask-scope", (route) =>
    route.fulfill({ json: ASK_SCOPE_SINGLE }),
  );
  await page.goto("/company/AAPL");

  const link = panel(page).getByRole("link", {
    name: "ask the 10-K filed Oct 31, 2025",
  });
  await expect(link).toHaveAttribute("href", "/analysis/1");
  await expect(page.getByRole("textbox", ASK_INPUT)).toHaveCount(0);
});

test("no indexed filing and a failed scope both render nothing", async ({
  page,
}) => {
  await mockApi(page);
  await page.route("**/api/companies/*/ask-scope", (route) =>
    route.fulfill({ json: { filings: [], eligible: false } }),
  );
  await page.goto("/company/AAPL");
  await expect(
    page.getByRole("region", { name: "Insider activity" }),
  ).toBeVisible();
  await expect(panel(page)).toHaveCount(0);

  await page.route("**/api/companies/*/ask-scope", (route) =>
    route.fulfill({ status: 502 }),
  );
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Insider activity" }),
  ).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
});

for (const [status, copy] of [
  [404, "Asking across filings needs at least two indexed filings."],
  [503, "Analysis service is at capacity — try again in a minute."],
  [429, "Rate limit reached — try again in a minute."],
] as const) {
  test(`a ${status} shows friendly copy and keeps the question`, async ({
    page,
  }) => {
    await mockApi(page);
    await page.route("**/api/companies/*/ask", (route) =>
      route.fulfill({ status, json: { detail: "raw backend text" } }),
    );
    await page.goto("/company/AAPL");

    const question = "How did Greater China net sales change?";
    await (await typeQuestion(page, question)).click();

    await expect(panel(page).getByText(copy)).toBeVisible();
    await expect(panel(page)).not.toContainText("raw backend text");
    await expect(page.getByRole("textbox", ASK_INPUT)).toHaveValue(question);
  });
}
