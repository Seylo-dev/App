// A failed deploy on the demo data (0.2.16): the error is the reason alone,
// the new container's last output sits in a collapsed block of its own
// (monospace, copyable, never in the step log or the red error), in the
// deploy log dialog and under the deploy in the history, and "Use port
// 6000" switches the service to the port its app listens on and deploys:
// on the service's newest deployment only, and not while a deploy runs.
// The Advanced tab waits for a running deploy before it changes the nodes
// or moves the service, and its Ports say that the domains, IP:port access
// and tunnel on the old main port follow a port typed in (with the next
// deploy when a version is live, else on save). Screenshots go to
// $SHOTS_DIR/deploy-failure.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { failedDeployError, failedDeployId, failedDeployOutput, failedNewestList, servicesById, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;

const shots = `${process.env.SHOTS_DIR ?? "shots"}/deploy-failure`;
/** The api's history with the failed deploy as its newest deployment, where the panel offers Use port. */
const newestFailed = (running = false) => ({
  "deployments.list": (input: Input) => failedNewestList(input, running),
  "deployments.get": (input: Input) => ({
    deployment: failedNewestList({ serviceId: input.serviceId }).deployments.find((d) => d.id === input.deploymentId),
    logTopic: `deployment:${input.deploymentId}`,
  }),
});

test.use({ storageState: stateFile });
test.beforeAll(() => mkdirSync(shots, { recursive: true }));

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

test("the history shows the reason, Use port and the app's own output apart", async ({ page }) => {
  const calls = watchOps(page);
  await installDemo(page, {
    overrides: {
      ...newestFailed(),
      "services.usePort": (input) => ({
        deploymentId: "d0000000000000a1",
        ports: [{ containerPort: input.port, protocol: "tcp" }],
        domainIds: [],
        domainsMove: "rollout",
      }),
    },
  });
  await page.goto(`/p/${ids.acme}/s/${svc.api}/deployments`);
  const history = page.getByRole("region", { name: "History" }).or(page.locator("section", { has: page.getByRole("heading", { name: "History" }) }));
  await expect(history.first().getByText(failedDeployError)).toBeVisible();
  const block = history.first().locator("details").filter({ hasText: "Last output of the new container" });
  await expect(block).toHaveCount(1);
  await expect(block).toContainText("on us-ash-1");
  await expect(block).toContainText("4 lines");
  // Collapsed: the lines are there but hidden until opened.
  await expect(block.getByText("Heartbeat 2")).toBeHidden();
  await block.locator("summary").click();
  await expect(block.getByText("Server is running on port 6000")).toBeVisible();
  await page.screenshot({ path: `${shots}/history.png` });

  await history.first().getByRole("button", { name: "Use port 6000" }).click();
  await expect(page.getByText("Port 6000 set. Deploying; the domains move to it when the new version rolls out.")).toBeVisible();
  expect(calls("services.usePort")).toEqual([{ serviceId: svc.api, port: 6000, fromPort: 3000 }]);
});

test("an older failed deploy keeps its output but offers no Use port", async ({ page }) => {
  // The demo's own history: newer deploys followed the failed one (canUsePort false).
  await installDemo(page);
  await page.goto(`/p/${ids.acme}/s/${svc.api}/deployments`);
  await expect(page.getByText(failedDeployError).first()).toBeVisible();
  await expect(page.locator("details").filter({ hasText: "Last output of the new container" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Use port 6000" })).toHaveCount(0);
});

test("Use port waits for a deploy in progress, like Roll back", async ({ page }) => {
  // The newest deploy failed, and another one (started elsewhere) is queued.
  const calls = watchOps(page);
  await installDemo(page, { overrides: newestFailed(true) });
  await page.goto(`/p/${ids.acme}/s/${svc.api}/deployments`);
  const button = page.getByRole("button", { name: "Use port 6000" }).first();
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("title", "A deploy is in progress. Wait for it, or cancel it, to deploy again.");
  expect(calls("services.usePort")).toEqual([]);
});

test("the deploy log dialog: the error once, the output collapsed and copyable, not in the step log", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await installDemo(page, { overrides: newestFailed() });
  await page.goto(`/p/${ids.acme}/s/${svc.api}/deployments`);
  const row = page
    .locator("div")
    .filter({ has: page.getByText(failedDeployError, { exact: true }) })
    .filter({ has: page.getByRole("button", { name: "Logs" }) })
    .last();
  await row.getByRole("button", { name: "Logs" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(failedDeployError, { exact: true })).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Use port 6000" })).toBeVisible();
  const block = dialog.locator("details").filter({ hasText: "Last output of the new container" });
  await expect(block.getByText("Heartbeat 1")).toBeHidden();
  await block.locator("summary").click();
  await expect(block.locator("code")).toHaveText(failedDeployOutput.join("\n"));
  await block.getByRole("button", { name: /copy/i }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(failedDeployOutput.join("\n"));
  // The deploy's own log never has the app's lines.
  await expect(dialog.getByRole("log").or(dialog.locator("[aria-label='Deploy log']")).first()).not.toContainText("Heartbeat");
  await page.screenshot({ path: `${shots}/dialog.png` });
  expect(failedDeployId).toBe("d000000000000013");
});

test("the Advanced tab waits for a running deploy to change the nodes or move the service", async ({ page }) => {
  const calls = watchOps(page);
  await installDemo(page);
  // The worker's push deploy is building.
  await page.goto(`/p/${ids.acme}/s/${svc.worker}/advanced`);
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Replicas and nodes" }) });
  const save = card.getByRole("button", { name: "Save" });
  // Replica counts alone may change meanwhile.
  await expect(save).toBeEnabled();
  await card.getByRole("combobox", { name: "Node" }).click();
  await page.getByRole("option", { name: "de-fsn-1" }).click();
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute("title", "A deploy is in progress. Wait for it, or cancel it, to change the nodes.");
  await expect(card.getByText("A deploy is in progress. Wait for it, or cancel it, to change the nodes.")).toBeVisible();
  await page.screenshot({ path: `${shots}/placements-wait.png` });
  const move = page.locator("section").filter({ has: page.getByRole("heading", { name: "Move to another node" }) });
  await move.getByRole("combobox", { name: "Move to" }).click();
  await page.getByRole("option", { name: "de-fsn-1" }).click();
  const moveButton = move.getByRole("button", { name: "Move", exact: true });
  await expect(moveButton).toBeDisabled();
  await expect(moveButton).toHaveAttribute("title", "A deploy is in progress. Wait for it, or cancel it, to change the nodes.");
  expect(calls("services.setPlacements")).toEqual([]);
  expect(calls("services.move")).toEqual([]);
});

const savedPorts = {
  "services.update": (input: Input) => ({ ...(servicesById[input.serviceId] as object), ports: input.ports }),
};

test("a main port typed in on the Advanced tab: what points at the old one follows with the next deploy", async ({ page }) => {
  const calls = watchOps(page);
  await installDemo(page, { overrides: savedPorts });
  // The api is live on port 3000.
  await page.goto(`/p/${ids.acme}/s/${svc.api}/advanced`);
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Container" }) });
  await expect(
    card.getByText("The first TCP port is the main one: change it and the domains, IP:port access and Cloudflare tunnel on the old one follow it."),
  ).toBeVisible();
  const note = card.getByRole("status");
  await expect(note).toHaveCount(0);
  const port = card.getByRole("textbox", { name: "Container port" }).first();
  await expect(port).toHaveValue("3000");
  await port.fill("6000");
  await expect(note).toHaveText(
    "The domains, IP:port access and Cloudflare tunnel on port 3000 move to 6000 when the next deploy rolls out, with the new containers. A domain on another port stays.",
  );
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/main-port-rollout.png` });
  // Back to 3000, or 3000 kept as another port: nothing follows.
  await port.fill("3000");
  await expect(note).toHaveCount(0);
  await port.fill("6000");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved").first()).toBeVisible();
  expect(calls("services.update").at(-1)?.ports).toEqual([{ containerPort: 6000, protocol: "tcp" }]);
});

test("a main port typed in for an app with nothing live: what points at the old one follows on save", async ({ page }) => {
  await installDemo(page, { overrides: savedPorts });
  // private-api never went live.
  await page.goto(`/p/${ids.acme}/s/${svc.privateApi}/advanced`);
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Container" }) });
  await card.getByRole("textbox", { name: "Container port" }).first().fill("8080");
  await expect(card.getByRole("status")).toHaveText(
    "The domains, IP:port access and Cloudflare tunnel on port 3000 move to 8080 when you save. A domain on another port stays.",
  );
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/main-port-now.png` });
});
