import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// WP-QA01 smoke lane. Runs against the local preview (product/scripts/local-preview.sh up),
// which is deterministic by default: dataMode "fixtures", LLM_PROVIDER=none.

test("home page loads and links to sign in", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "A name in. A cited tear sheet out." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
});

test("login page has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/login");
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
});
