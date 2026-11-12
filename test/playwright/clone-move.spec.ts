// The service menu's Clone and Move to project dialogs, on the demo data.
// The ops behind them answer from per-test overrides, which also record
// what the dialogs sent.

import { ids, projects } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

const apiPage = `/p/${ids.acme}/s/${ids.api}`;

test.describe("clone and move", () => {
  test.use({ storageState: stateFile });

  test("Clone: pickers, what comes along, data copy and automatic domain", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const sent: Record<string, unknown>[] = [];
    await installDemo(page, {
      overrides: {
        "services.clonePreview": (input) => ({
          name: input.projectId === ids.personal ? "api" : "api-copy",
          kind: "app",
          projectId: input.projectId ?? ids.acme,
          nodeId: input.nodeId ?? ids.de,
          // In personal this person cannot edit env, so it stays behind.
          env: input.projectId === ids.personal ? "noWrite" : "copied",
          volumes: [{ name: "uploads", mountPath: "/app/uploads" }],
          data: { available: true, blockedBy: null, alwaysStops: false },
          autoDomain: "api-copy.de1.acme.dev",
          middlewares: true,
          references:
            input.projectId === ids.personal
              ? [{ key: "DATABASE_URL", target: "db.INTERNAL_URL", via: "reference", effect: "unresolved" }]
              : [{ key: "SELF_URL", target: "api:8080", via: "hostname", effect: "renamed" }],
        }),
        "services.clone": (input) => {
          sent.push(input);
          return {
            service: { id: "svcapicopy00000a", projectId: input.projectId, name: input.name },
            copied: { env: true, fileMounts: false, databaseLogins: false, middlewares: true, autoDomain: "api-copy.de1.acme.dev" },
            dataCopy: null,
          };
        },
      },
    });
    await page.goto(apiPage);
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Clone" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Clone api" })).toBeVisible();
    // The suggested name arrives with the preview; the placeholders go once it is in.
    await expect(dialog.getByLabel("Name")).toHaveValue("api-copy");
    await expect(dialog.locator('[data-slot="skeleton"]')).toHaveCount(0);
    await expect(dialog.getByText("Environment variables and config files")).toBeVisible();
    await expect(dialog.getByText("Not copied: domains, deploy history")).toBeVisible();
    // Its own host name in a value now names the clone; not a warning.
    await expect(dialog.getByText("These variables named api itself and now name the clone:")).toBeVisible();
    await expect(dialog.getByText("SELF_URL")).toBeVisible();
    await expect(dialog.getByText("In acme-shop these variables point somewhere else:")).toHaveCount(0);

    // Another project: the references that change show up, and the env stays behind there.
    await dialog.getByLabel("Project").click();
    await page.getByRole("option", { name: "personal" }).click();
    await expect(dialog.getByText("DATABASE_URL")).toBeVisible();
    await expect(dialog.getByText("you cannot edit them in personal")).toBeVisible();
    await expect(dialog.getByText("SELF_URL")).toHaveCount(0);
    await expect(dialog.getByLabel("Name")).toHaveValue("api");
    await dialog.getByLabel("Project").click();
    await page.getByRole("option", { name: "acme-shop" }).click();

    await dialog.getByRole("radio", { name: /Copy data/ }).click();
    await expect(dialog.getByText("Stop api while its data is copied")).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /Add the automatic domain api-copy\.de1\.acme\.dev/ })).toBeChecked();
    await dialog.getByLabel("Name").fill("api-staging");
    await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "shots"}/clone-dialog.png` });
    await dialog.getByRole("button", { name: "Clone", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("api-staging created")).toBeVisible();
    expect(sent).toEqual([
      {
        serviceId: ids.api,
        projectId: ids.acme,
        nodeId: ids.de,
        name: "api-staging",
        data: "copy",
        stopSource: true,
        autoDomain: true,
        deployOnPush: true,
      },
    ]);
    expect(errors).toEqual([]);
  });

  test("Clone: Deploy on push starts as the source's, for repository sources only", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const sent: Record<string, unknown>[] = [];
    await installDemo(page, {
      overrides: {
        "services.clonePreview": (input) => ({
          name: "copy",
          kind: "app",
          projectId: input.projectId ?? ids.acme,
          nodeId: input.nodeId ?? ids.de,
          env: "none",
          volumes: [],
          data: { available: false, blockedBy: "noVolumes", alwaysStops: false },
          autoDomain: null,
          middlewares: false,
          references: [],
        }),
        "services.clone": (input) => {
          sent.push(input);
          return {
            service: { id: "svccopy0000000aa", projectId: input.projectId, name: input.name },
            copied: { env: false, fileMounts: false, databaseLogins: false, middlewares: false, autoDomain: null },
            dataCopy: null,
          };
        },
      },
    });
    const openClone = async (path: string, name: string) => {
      await page.goto(path);
      await page.getByRole("button", { name: "More actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Clone" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: `Clone ${name}` })).toBeVisible();
      await expect(dialog.getByLabel("Name")).toHaveValue("copy");
      return dialog;
    };

    // api follows acme/shop-api on main through the GitHub App, deploying on push: the clone does too.
    let dialog = await openClone(apiPage, "api");
    const push = dialog.getByRole("switch", { name: "Deploy on push" });
    await expect(push).toBeChecked();
    await expect(dialog.getByText("Each push to main deploys both api and the clone.")).toBeVisible();
    await push.click();
    await expect(push).not.toBeChecked();
    await expect(dialog.getByText("Pushes to main do not deploy the clone.")).toBeVisible();
    await dialog.getByRole("button", { name: "Clone", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(sent.at(-1)).toMatchObject({ serviceId: ids.api, name: "copy", deployOnPush: false });

    // A git URL that does not deploy on push: off to start with; on, the note says the trigger URL stays behind.
    dialog = await openClone(`/p/${ids.acme}/s/svcprivapi0000d1`, "private-api");
    const gitPush = dialog.getByRole("switch", { name: "Deploy on push" });
    await expect(gitPush).not.toBeChecked();
    await expect(dialog.getByText("Pushes to main do not deploy the clone.")).toBeVisible();
    await gitPush.click();
    await expect(dialog.getByText("deploys on push through a deploy trigger URL, which the clone does not copy")).toBeVisible();
    await dialog.getByRole("button", { name: "Clone", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(sent.at(-1)).toMatchObject({ serviceId: "svcprivapi0000d1", deployOnPush: true });

    // A database runs an image: no switch, and nothing about pushes is sent.
    dialog = await openClone(`/p/${ids.acme}/s/${ids.db}`, "db");
    await expect(dialog.getByText("Source, build, health check")).toBeVisible();
    await expect(dialog.getByRole("switch", { name: "Deploy on push" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Clone", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(sent.at(-1)).toEqual({ serviceId: ids.db, projectId: ids.acme, nodeId: ids.de, name: "copy" });
    expect(errors).toEqual([]);
  });

  test("Move to project: the impact list, the tick, and blockers", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const sent: Record<string, unknown>[] = [];
    let blocked = false;
    await installDemo(page, {
      overrides: {
        "services.moveProjectImpact": () => ({
          blockers: blocked ? [{ reason: "nameTaken", message: "personal already has a service named api. Rename one of them first." }] : [],
          referencedBy: [{ serviceId: ids.worker, name: "worker", keys: ["API_URL"] }],
          hiddenReferrers: 1,
          targetReferrers: [],
          hiddenTargetReferrers: 0,
          ownReferences: [{ key: "DATABASE_URL", target: "db.INTERNAL_URL", via: "reference", effect: "unresolved" }],
          sharedLost: { count: 2, names: ["SENTRY_DSN", "LOG_LEVEL"] },
          grants: { count: 1, names: ["Dana"] },
          invites: 0,
          switches: true,
        }),
        "services.moveProject": (input) => {
          sent.push(input);
          return { deploymentId: "d0000000000000mv", impact: {} };
        },
      },
    });
    await page.goto(apiPage);
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Move to project" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Move api to another project" })).toBeVisible();
    const impact = dialog.getByTestId("move-impact");
    await expect(impact.getByText("worker")).toBeVisible();
    await expect(impact.getByText("API_URL")).toBeVisible();
    await expect(impact.getByText("and 1 service you cannot see")).toBeVisible();
    await expect(impact.getByText("DATABASE_URL")).toBeVisible();
    await expect(impact.getByText("It stops receiving 2 shared variables")).toBeVisible();
    await expect(impact.getByText("1 person loses their access to it")).toBeVisible();
    await expect(impact.getByText(/like a deploy/)).toBeVisible();

    const move = dialog.getByRole("button", { name: "Move", exact: true });
    await expect(move).toBeDisabled();
    await dialog.getByRole("checkbox", { name: "I have read what changes" }).click();
    await expect(move).toBeEnabled();
    await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "shots"}/move-project-dialog.png` });
    await move.click();
    await expect(dialog).toBeHidden();
    expect(sent).toEqual([{ serviceId: ids.api, projectId: ids.personal, confirm: true }]);
    await expect(page).toHaveURL(new RegExp(`/p/${ids.personal}/s/${ids.api}`));

    // A blocker keeps the button off.
    blocked = true;
    await page.goto(apiPage);
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Move to project" }).click();
    await expect(dialog.getByText("This move cannot run:")).toBeVisible();
    await expect(dialog.getByText("Rename one of them first")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Move", exact: true })).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test("Move to project: the project stays locked while the move runs, and the page follows the one it went to", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const sent: Record<string, unknown>[] = [];
    // A second project to move to, so the picker has a choice to change.
    const staging = { ...projects[1], id: "projstaging00004", name: "staging", position: 3 };
    await installDemo(page, {
      delay: (op) => (op === "services.moveProject" ? 1500 : 0),
      overrides: {
        "projects.list": () => ({ projects: [...projects, staging] }),
        "services.moveProjectImpact": () => ({
          blockers: [],
          referencedBy: [],
          hiddenReferrers: 0,
          targetReferrers: [],
          hiddenTargetReferrers: 0,
          ownReferences: [],
          sharedLost: { count: 0, names: [] },
          grants: { count: 0, names: [] },
          invites: 0,
          switches: true,
        }),
        "services.moveProject": (input) => {
          sent.push(input);
          return { deploymentId: "d0000000000000mv", impact: {} };
        },
      },
    });
    await page.goto(apiPage);
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Move to project" }).click();
    const dialog = page.getByRole("dialog");
    const picker = dialog.getByRole("combobox", { name: "New project" });
    await expect(picker).toHaveText("personal");
    await expect(dialog.getByTestId("move-impact")).toBeVisible();
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    // While services.moveProject runs, another pick would name the wrong project in the toast and the URL.
    await expect(picker).toBeDisabled();
    await expect(dialog).toBeHidden();
    expect(sent).toEqual([{ serviceId: ids.api, projectId: ids.personal }]);
    await expect(page).toHaveURL(new RegExp(`/p/${ids.personal}/s/${ids.api}$`));
    await expect(page.getByText("Moving api to personal.")).toBeVisible();
    expect(errors).toEqual([]);
  });
});
