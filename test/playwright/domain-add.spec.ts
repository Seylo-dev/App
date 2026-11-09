// The Add domain dialog on the demo data: on a service with no port the
// Container port field says 80 and an empty field adds the domain on 80
// (the PORT a repository-built app gets); on a service with no primary
// domain yet "Make it the primary domain" is ticked and locked, since the
// panel makes that domain primary anyway; with a primary one it is a free
// choice, off. Screenshots go to $SHOTS_DIR/domain-add.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;

const shots = `${process.env.SHOTS_DIR ?? "shots"}/domain-add`;

test.use({ storageState: stateFile });

function watchOps(page: Page) {
  const calls: { op: string; input: Input }[] = [];
  page.on("request", (request) => {
    const match = /\/api\/v1\/([a-zA-Z]+\.[a-zA-Z]+)/.exec(request.url());
    if (!match) return;
    const input = request.method() === "GET" ? Object.fromEntries(new URL(request.url()).searchParams) : (request.postDataJSON() ?? {});
    calls.push({ op: match[1] as string, input });
  });
  return (op: string) => calls.filter((c) => c.op === op).map((c) => c.input);
}

const added = (input: Input) => ({
  domain: { id: "m00000000000000f", host: input.host, primary: true, targetPort: input.targetPort },
  dns: { status: "ok" },
});

test("the first domain of a portless app: port 80 by default, and primary ticked and locked", async ({ page }) => {
  const calls = watchOps(page);
  // The worker has no port; nothing on it yet.
  await installDemo(page, { overrides: { "domains.list": () => ({ domains: [], autoDomainSuggestion: null }), "domains.add": added } });
  await page.goto(`/p/${ids.acme}/s/${svc.worker}/domains`);
  await page.getByRole("button", { name: "Add domain" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add a domain" });
  await expect(dialog.getByLabel("Container port")).toHaveAttribute("placeholder", "80");
  await expect(dialog.getByLabel("Container port")).toHaveValue("");
  const primary = dialog.getByRole("checkbox", { name: "Make it the primary domain" });
  await expect(primary).toBeChecked();
  await expect(primary).toBeDisabled();
  await dialog.getByLabel("Domain", { exact: true }).fill("jobs.example.com");
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/first-domain.png` });
  await dialog.getByRole("button", { name: "Add domain" }).click();
  await expect
    .poll(() => calls("domains.add"))
    .toEqual([expect.objectContaining({ serviceId: svc.worker, host: "jobs.example.com", targetPort: 80, primary: true })]);
});

test("with a primary domain already, the box is a free choice and starts off", async ({ page }) => {
  await installDemo(page);
  await page.goto(`/p/${ids.acme}/s/${svc.api}/domains`);
  await page.getByRole("button", { name: "Add domain" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add a domain" });
  const primary = dialog.getByRole("checkbox", { name: "Make it the primary domain" });
  await expect(primary).not.toBeChecked();
  await expect(primary).toBeEnabled();
  await primary.click();
  await expect(primary).toBeChecked();
});
