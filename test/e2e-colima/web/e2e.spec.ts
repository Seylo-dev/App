// The e2e panel in a browser: sign in as the owner, the dashboard shows the
// three nodes and the services, every service tab loads, the console works,
// and no page throws.

import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const [email = "", password = ""] = readFileSync(process.env.E2E_OWNER_FILE ?? "", "utf8").trim().split("\n");
const apiKey = process.env.E2E_API_KEY ?? "";
const tabs = ["", "deployments", "source", "environment", "domains", "logs", "console", "shell", "metrics", "storage", "settings"];

async function api<T>(page: Page, op: string, query: Record<string, string> = {}): Promise<T> {
  const response = await page.request.get(`/api/v1/${op}?${new URLSearchParams(query)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  expect(response.ok(), `${op} answered ${response.status()}`).toBeTruthy();
  return (await response.json()) as T;
}

test("dashboard, services, tabs and console", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // The dashboard greets by the time of day (0.2.5): "Good morning, ...".
  await expect(page.getByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening|night)/ })).toBeVisible();

  const { nodes } = await api<{ nodes: { name: string; status: string }[] }>(page, "nodes.list");
  expect(nodes.filter((node) => node.status === "online").length).toBeGreaterThanOrEqual(3);
  for (const node of nodes) await expect(page.getByText(node.name, { exact: false }).first()).toBeVisible();

  const { projects } = await api<{ projects: { id: string; name: string }[] }>(page, "projects.list");
  const project = projects.find((p) => p.name === "e2e");
  expect(project, "the e2e project").toBeTruthy();
  const { services } = await api<{ services: { id: string; name: string; kind: string }[] }>(page, "services.list", {
    projectId: project?.id ?? "",
  });
  await page.goto(`/p/${project?.id}`);
  for (const name of ["whoami", "node-app"]) await expect(page.getByText(name, { exact: true }).first()).toBeVisible();

  const echoer = services.find((s) => s.name === "echoer") ?? services.find((s) => s.name === "whoami");
  expect(echoer).toBeTruthy();
  // Tabs the way people use them: client-side links from the service page.
  const base = `/p/${project?.id}/s/${echoer?.id}`;
  await page.goto(base);
  await page.waitForLoadState("networkidle");
  const visited: string[] = [];
  for (const tab of tabs.filter(Boolean)) {
    const link = page.locator(`a[href$="${base}/${tab}"]`).first();
    if ((await link.count()) === 0) continue;
    visited.push(tab);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${base}/${tab}`));
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/This page failed to load|Something went wrong|Unexpected Application Error/i)).toHaveCount(0);
  }
  console.log(`service tabs visited: ${visited.join(", ")}`);
  expect(visited.length, "service tab links").toBeGreaterThanOrEqual(8);

  await page.goto(`/p/${project?.id}/s/${echoer?.id}/console`);
  // The console's input line sends to the main process's stdin.
  const input = page.getByPlaceholder(/goes to its stdin/i);
  await expect(input).toBeVisible();
  await input.fill("browser-e2e");
  await input.press("Enter");
  await expect(page.getByText("echo:browser-e2e")).toBeVisible({ timeout: 20_000 });

  expect(errors, errors.join("\n")).toEqual([]);
});
