import { test, expect } from "@playwright/test";
import { mockApi, ASK_ANSWER } from "./mocks";

/** "Ask this filing" — RAG Q&A card on the analysis dashboard (roadmap 5.1). */

test("ask a question → cited answer", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  const input = page.getByRole("textbox", {
    name: "Ask a question about this filing",
  });
  await input.fill("What are the main revenue drivers?");
  await page.getByRole("button", { name: "Ask" }).click();

  await expect(page.getByText(ASK_ANSWER.answer)).toBeVisible();

  // Sources are collapsed until asked for, then list every excerpt
  const sources = page.getByText("Sources (2)");
  await expect(sources).toBeVisible();
  await expect(page.getByText(ASK_ANSWER.sources[0]!.excerpt)).toBeHidden();
  await sources.click();
  await expect(page.getByText(ASK_ANSWER.sources[0]!.excerpt)).toBeVisible();
  await expect(page.getByText(ASK_ANSWER.sources[1]!.excerpt)).toBeVisible();
});

test("keyboard-only: Enter submits the question", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  const input = page.getByRole("textbox", {
    name: "Ask a question about this filing",
  });
  await input.fill("What are the main revenue drivers?");
  await input.press("Enter");

  await expect(page.getByText(ASK_ANSWER.answer)).toBeVisible();
});

test("a suggested question asks in one click and fills the input", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  await page
    .getByRole("button", { name: "Which risks does the company describe as most significant?" })
    .click();

  await expect(page.getByText(ASK_ANSWER.answer)).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Ask a question about this filing" })
  ).toHaveValue("Which risks does the company describe as most significant?");
});

test("un-indexed filing shows the friendly Q&A-unavailable copy", async ({
  page,
}) => {
  await mockApi(page);
  await page.route("**/api/analysis/*/ask", (route) =>
    route.fulfill({
      status: 404,
      json: { detail: "Q&A isn't available for this filing" },
    })
  );
  await page.goto("/analysis/1");

  await page
    .getByRole("textbox", { name: "Ask a question about this filing" })
    .fill("What are the main revenue drivers?");
  await page.getByRole("button", { name: "Ask" }).click();

  // Filter: Next's route announcer is also role=alert.
  await expect(
    page.getByRole("alert").filter({ hasText: "Q&A isn't available" })
  ).toBeVisible();
});

test("the Ask button is disabled until a question is typed", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  const button = page.getByRole("button", { name: "Ask" });
  await expect(button).toBeDisabled();

  await page
    .getByRole("textbox", { name: "Ask a question about this filing" })
    .fill("What are the main revenue drivers?");
  await expect(button).toBeEnabled();
});
