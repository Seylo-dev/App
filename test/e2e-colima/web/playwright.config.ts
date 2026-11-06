// Web smoke against the e2e panel in VM A (checks.sh check 30). The spec
// imports @playwright/test from test/playwright/node_modules (checks.sh links
// it here). E2E_PANEL_URL, E2E_OWNER_FILE and E2E_API_KEY come from checks.sh.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: process.env.E2E_SHOTS ?? "test-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.E2E_PANEL_URL,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
});
