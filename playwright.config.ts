import { defineConfig, devices } from "@playwright/test";

// WP-QA01: the deterministic smoke lane. Runs against the local preview
// (product/scripts/local-preview.sh up), which serves with AUTH_REQUIRED=1,
// dataMode "fixtures" and LLM_PROVIDER=none by default, so this makes no live
// Companies House call and no model call. Chromium and the iPhone 13 profile only,
// WebKit is dropped.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3107",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "iphone-13", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
});
