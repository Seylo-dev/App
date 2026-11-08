// Internal git hosts in the browser, on the demo data: a member refused for
// an internal git host on the Source tab sees who can allow it, and one whose
// host does not resolve is told to check the address; an owner (whose save
// records the host, so the panel never refuses them there) lists, allows and
// removes the project's hosts in its Settings, and allows a host from a
// deployment the node refused for it.

import { expect, type Page, test } from "@playwright/test";
import { installDemo } from "./demo/routes";
import { handlers as serviceHandlers, ids as svc } from "./demo/service";
import { ids, viewer } from "./demo/fixtures";
import { stateFile } from "./helpers";

type Input = Record<string, any>;

const shots = `${process.env.SHOTS_DIR ?? "shots"}/internal-git-hosts`;
const repo = "https://git.example.com/acme/shop-api.git";
const now = new Date().toISOString();

function watchApi(page: Page) {
  const calls: { op: string; input: Input }[] = [];
  page.on("request", (request) => {
    const match = /\/api\/v1\/([a-zA-Z]+\.[a-zA-Z]+)/.exec(request.url());
    if (match && request.method() === "POST") calls.push({ op: match[1] as string, input: request.postDataJSON() ?? {} });
  });
  return calls;
}

/** The demo's own answer for services.get, so overrides can build on it. */
function serviceDetail(serviceId: string): Input {
  return (serviceHandlers["services.get"] as (input: Input) => Input)({ serviceId });
}

const gitSource = (input: Input) => ({
  ...serviceDetail(input.serviceId as string),
  source: { type: "git", label: repo, branch: "main", builder: "railpack" },
  sourceConfig: { type: "git", url: repo, branch: "main", credentialId: null, deployOnPush: false },
});

/** git.branches refused the way the panel refuses a member for where the host is. */
async function refuseBranches(page: Page, refusal: "internalTarget" | "unresolvable" = "internalTarget") {
  const error =
    refusal === "internalTarget"
      ? {
          code: "BAD_REQUEST",
          message:
            "The git host is an address of one of this panel's nodes (51.15.20.30). Only an admin can use an internal git host; once an admin saves a source with it in this project (or allows it with git.allowInternalHost), its members can use it too.",
          details: { field: "url", reason: "internalTarget", host: "git.example.com" },
        }
      : {
          code: "BAD_REQUEST",
          message: "The name git.example.com did not resolve.",
          details: { field: "url", reason: "unresolvable", host: "git.example.com" },
        };
  await page.route(/\/api\/v1\/git\.branches/, (route) =>
    route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error }) }),
  );
}

const asMember = { "auth.whoami": () => ({ viewer: { ...viewer, role: "member" }, via: "session" }) };

test.describe("internal git hosts", () => {
  test.use({ storageState: stateFile });

  test("a member refused for an internal git host sees who can allow it", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installDemo(page, {
      overrides: { ...asMember, "services.get": gitSource, "git.listCredentials": () => ({ items: [] }) },
    });
    await refuseBranches(page);
    await page.goto(`/p/${ids.acme}/s/${svc.api}/source`);
    await page.getByRole("button", { name: "Check access" }).click();
    await expect(page.getByText(/an address of one of this panel's nodes/)).toBeVisible();
    await expect(page.getByText(/Only an owner or admin of this panel can allow it for acme-shop/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Allow this host/ })).toHaveCount(0);
    await page.screenshot({ path: `${shots}/source-refused.png`, fullPage: true });
    expect(errors).toEqual([]);
  });

  test("a member whose git host does not resolve is told to check the address", async ({ page }) => {
    await installDemo(page, {
      overrides: { ...asMember, "services.get": gitSource, "git.listCredentials": () => ({ items: [] }) },
    });
    await refuseBranches(page, "unresolvable");
    await page.goto(`/p/${ids.acme}/s/${svc.api}/source`);
    await page.getByRole("button", { name: "Check access" }).click();
    await expect(page.getByText("The name git.example.com did not resolve.")).toBeVisible();
    await expect(page.getByText(/git\.example\.com does not resolve from the panel\. Check the address\./)).toBeVisible();
    await expect(page.getByText(/is on an internal address/)).toHaveCount(0);
  });

  test("an owner lists, allows and removes the project's internal git hosts in its Settings", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const calls = watchApi(page);
    let items: Input[] = [
      { host: "git.example.com", approvedBy: { id: viewer.id, name: "Ada" }, createdAt: now, usedBy: 2 },
      { host: "10.0.0.7:3000", approvedBy: null, createdAt: now, usedBy: 0 },
    ];
    await installDemo(page, {
      overrides: {
        "git.listInternalHosts": () => ({ items }),
        "git.allowInternalHost": () => {
          items = [...items, { host: "gitea.corp.example", approvedBy: { id: viewer.id, name: "Ada" }, createdAt: now, usedBy: 0 }];
          return { host: "gitea.corp.example" };
        },
        "git.removeInternalHost": (input) => {
          items = items.filter((h) => h.host !== input.host);
          return {};
        },
      },
    });
    await page.goto(`/p/${ids.acme}?tab=settings`);
    const section = page.getByRole("region", { name: "Internal git hosts" }).or(page.locator("section", { hasText: "Internal git hosts" }));
    await expect(section.getByText("git.example.com")).toBeVisible();
    await expect(section.getByText("Recorded on upgrade")).toBeVisible();
    await expect(section.getByText("2 sources")).toBeVisible();

    await section.getByLabel("Allow a host").fill("https://gitea.corp.example/team/app.git");
    await section.getByRole("button", { name: "Allow", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Allow gitea.corp.example for acme-shop?")).toBeVisible();
    await dialog.getByRole("button", { name: "Allow host" }).click();
    await expect(section.getByText("gitea.corp.example")).toBeVisible();
    expect(calls.find((c) => c.op === "git.allowInternalHost")?.input).toEqual({
      projectId: ids.acme,
      url: "https://gitea.corp.example/team/app.git",
    });
    await page.screenshot({ path: `${shots}/project-settings.png`, fullPage: true });

    await section.getByRole("row", { name: /git\.example\.com/ }).getByRole("button", { name: "Remove" }).click();
    await expect(dialog.getByText("Stop allowing git.example.com?")).toBeVisible();
    await expect(dialog.getByText(/2 sources in acme-shop clone from this host/)).toBeVisible();
    await dialog.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("git.example.com is no longer allowed.")).toBeVisible();
    expect(calls.find((c) => c.op === "git.removeInternalHost")?.input).toEqual({ projectId: ids.acme, host: "git.example.com" });
    await expect(section.getByRole("row", { name: /^git\.example\.com/ })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("an owner allows the host of a deployment the node refused", async ({ page }) => {
    const calls = watchApi(page);
    const refused =
      "fetching the source failed: the node refused to connect to git.example.com:443: git.example.com resolves to 10.20.0.5, a private address. Nodes clone only from public addresses other than their own; an admin can allow internal addresses of this host for the project (the project's Settings > Internal git hosts, or git.allowInternalHost)";
    await installDemo(page, {
      overrides: {
        "services.get": gitSource,
        "deployments.list": (input) => {
          const list = (serviceHandlers["deployments.list"] as (i: Input) => { deployments: Input[] })(input).deployments;
          return {
            deployments: [{ ...list[0], status: "failed", live: false, error: refused, canRollback: false }, ...list.slice(1)],
            nextCursor: null,
            keptImages: 5,
          };
        },
        "git.allowInternalHost": () => ({ host: "git.example.com" }),
      },
    });
    await page.goto(`/p/${ids.acme}/s/${svc.api}/deployments`);
    await expect(page.getByText(/the node refused to connect to git\.example\.com:443/)).toBeVisible();
    await page.getByRole("button", { name: "Allow this host for acme-shop" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Allow host" }).click();
    await expect(page.getByText("git.example.com allowed for acme-shop.")).toBeVisible();
    expect(calls.find((c) => c.op === "git.allowInternalHost")?.input).toEqual({ projectId: ids.acme, url: repo });
  });
});
