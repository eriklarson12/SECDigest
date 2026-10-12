import { test, expect, type Page } from "@playwright/test";
import { mockApi, ASK_ANSWER } from "./mocks";

/** Print stylesheet for the analysis page (roadmap 14.3). */

/** The same hydration retry as ask.spec.ts: a fill() before hydration never reaches state. */
async function askQuestion(page: Page, question: string) {
  const input = page.getByRole("textbox", {
    name: "Ask a question about this filing",
  });
  const button = page.getByRole("button", { name: "Ask" });
  await expect(async () => {
    await input.fill(question);
    await expect(button).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await button.click();
  await expect(page.getByText(ASK_ANSWER.answer)).toBeVisible();
}

test("print hides the controls and keeps the content", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");
  const question = "What are the main revenue drivers?";
  await askQuestion(page, question);

  const controls = [
    page.getByRole("navigation"),
    page.getByRole("button", { name: "Add AAPL to watchlist" }),
    page.getByRole("group", { name: "Chart period" }),
    page.getByRole("textbox", { name: "Ask a question about this filing" }),
    page.getByRole("group", { name: "Suggested questions" }),
  ];
  // Visible on screen first, so the print assertions below cannot pass vacuously.
  for (const control of controls) await expect(control).toBeVisible();
  const header = page.getByText(/^SECDigest · .*\/analysis\/1$/);
  await expect(header).toBeHidden();
  await expect(page.getByText(ASK_ANSWER.sources[0]!.excerpt)).toBeHidden();

  await page.emulateMedia({ media: "print" });

  for (const control of controls) await expect(control).toBeHidden();
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeHidden();
  await expect(header).toBeVisible();
  // The answer prints with the question it answers, and its sources open.
  await expect(page.getByText(question, { exact: true })).toBeVisible();
  await expect(page.getByText(ASK_ANSWER.answer)).toBeVisible();
  await expect(page.getByText(ASK_ANSWER.sources[0]!.excerpt)).toBeVisible();
});

test("an unused Ask tool does not print", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");
  const heading = page.getByRole("heading", { name: "Ask This Filing" });
  await expect(heading).toBeVisible();

  await page.emulateMedia({ media: "print" });
  await expect(heading).toBeHidden();
});

test("print spells out EDGAR links and only those", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");
  await page.emulateMedia({ media: "print" });

  // By selector, not role: in print the generated URL joins the link's accessible name.
  const after = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => getComputedStyle(el, "::after").content);

  expect(await after('a:has-text("View filing on SEC.gov")')).toContain(
    "https://www.sec.gov/",
  );
  expect(await after('a[href="/company/AAPL"]')).toBe("none");
});
