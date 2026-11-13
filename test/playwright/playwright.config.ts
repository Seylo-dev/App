// One browser, one worker: the smoke spec is ordered (setup first) and
// shares the panel's state; the other specs need the owner it creates, so
// they depend on it. run.sh sets BASE_URL and the panel data dir.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: process.env.RESULTS_DIR ?? "test-results",
  use: {
    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:5251",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "smoke", testMatch: /smoke\.spec\.ts$/, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    {
      name: "app",
      testMatch: /(flows|reauth|screens|motion|loading|editor|copy|dockerhub|git-providers|git-credentials|internal-git-hosts|nodeops|clone-move|databases|database-version|database-users|certificates|updates|env-save|env-references|toasts|tailscale|nodes-build-default|panel-access|build-settings|hide-projects|console|repo-picker|sidebar-new-service|github-account|deploy-lock|domain-add|settings-cleanup|settings-ai|mcp-setup|template-logos|sidebar-items|personal-details|project-order|project-image|push-notifications|node-location|node-address|dashboard-views|docker-check|assistant|node-live|appearance|panel-move|service-transfer|build-args-public|env-hint|node-builds-auto|build-wait|backups|service-header|database-timed-expose|env-domains)\.spec\.ts$/,
      dependencies: ["smoke"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
  ],
});
