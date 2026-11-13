// A database's Advanced tab (0.2.16) on the demo data: Move to another
// node, its resource limits (saved with a restart) and its crash policy,
// nothing the engine manages. The node picker says why a node cannot take
// it, the Move dialog says what happens (downtime with its size, the same
// internal address and who loses it on another node, the exposed port and
// timed expose moving to the new address, the services reading EXPOSED_*
// that need a deploy, backups, the old copy), and the database's menu has
// Move to another node. demo/service.ts moveImpactOf stands in for the
// panel; the move itself is answered here. While it moves, db has both
// nodes' placements (the move job adds the new one first) and the card
// shows the move with its log. Since 0.2.17 the header says "Moving to
// <node>..." on every tab, with Cancel move after a confirm while the
// panel takes a cancel (Deployment.move.canCancel: while it copies) and
// none once it starts on the new node, and never Cancel deploy, Restart,
// Stop or Start meanwhile.
//
// Screenshots: $SHOTS_DIR/database-move/*.png.

import { mkdirSync } from "node:fs";
import { ids } from "./demo/fixtures";
import { DemoRefusal } from "./demo/refusal";
import { installDemo } from "./demo/routes";
import { handlers as serviceHandlers, moveImpactOf, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/database-move`;
const advanced = `/p/${ids.acme}/s/${svc.db}/advanced`;

test.describe("database move", () => {
  test.use({ storageState: stateFile });
  test.beforeAll(() => mkdirSync(shots, { recursive: true }));

  test("the Advanced tab: the Move card with why a node cannot take it, limits with a restart, the crash policy", async ({ page }) => {
    await installDemo(page);
    await page.goto(`/p/${ids.acme}/s/${svc.db}/connection`);
    const tabs = page.getByLabel("Service sections");
    // Between Alerts and Notes.
    await expect(tabs.getByRole("link")).toHaveText([
      "Connection",
      "Users",
      "Backups",
      "Logs",
      "Metrics",
      "Storage",
      "Alerts",
      "Advanced",
      "Notes",
      "Settings",
    ]);
    await tabs.getByRole("link", { name: "Advanced" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${svc.db}/advanced`));

    const move = page.locator("#move");
    await expect(move.getByText("Copies its data to another node while it is stopped")).toBeVisible();
    await expect(move.getByText("Cannot move to:")).toBeVisible();
    await expect(move.getByText("The agent on il-tlv-1 cannot keep PostgreSQL's exposed port TLS only yet")).toBeVisible();
    await move.getByLabel("Move to").click();
    await expect(page.getByRole("option", { name: "il-tlv-1 · cannot take it" })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("option", { name: "us-ash-1", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Resource limits" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Save and restart" })).toBeVisible();
    await expect(page.getByText("The database restarts with them, offline for a few seconds.")).toBeVisible();
    await expect(main.getByRole("heading", { name: "Crash policy" })).toBeVisible();
    // What the engine manages is not offered.
    for (const title of ["Health check and deploys", "Replicas and nodes", "Container"]) {
      await expect(main.getByRole("heading", { name: title, exact: true })).toHaveCount(0);
    }
    await page.screenshot({ path: `${shots}/advanced-tab.png`, fullPage: true });
  });

  test("the Move dialog says what happens, the move goes to the node picked, and the card shows it while it runs", async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    let moved = false;
    const worker = serviceHandlers["deployments.list"]?.({ serviceId: svc.worker }) as { deployments: Record<string, unknown>[] };
    const moveDeploy = {
      ...worker.deployments[0],
      id: "d000000000000099",
      serviceId: svc.db,
      status: "deploying",
      trigger: "move",
      actor: "you@example.com",
      commit: null,
      source: null,
      builder: null,
      builtOn: null,
    };
    await installDemo(page, {
      overrides: {
        "services.move": (input) => {
          sent.push(input);
          moved = true;
          return { deploymentId: moveDeploy.id };
        },
        // As the move job does: us-ash-1's placement first, then the stop and the copy.
        "services.get": (input) => {
          const base = serviceHandlers["services.get"]?.(input) as { placements: unknown[] };
          if (!moved || input.serviceId !== svc.db) return base;
          return { ...base, placements: [...base.placements, { nodeId: ids.us, nodeName: "us-ash-1", replicas: 1 }] };
        },
        "deployments.list": (input) =>
          moved && input.serviceId === svc.db && String(input.active) === "true"
            ? { deployments: [moveDeploy], nextCursor: null, keptImages: 0 }
            : serviceHandlers["deployments.list"]?.(input),
        "deployments.get": (input) =>
          input.deploymentId === moveDeploy.id
            ? { deployment: moveDeploy, logTopic: `deployment:${moveDeploy.id}` }
            : serviceHandlers["deployments.get"]?.(input),
      },
    });
    await page.goto(advanced);
    const move = page.locator("#move");
    await move.getByLabel("Move to").click();
    await page.getByRole("option", { name: "us-ash-1", exact: true }).click();

    // Before anything moves, the card says what happens there.
    const notes = move.getByRole("list", { name: "What happens when it moves to us-ash-1" });
    // Downtime, with what the panel knows of its size.
    await expect(notes).toContainText("db stops while its data is copied to us-ash-1, and is offline until it starts there");
    await expect(notes).toContainText("About 1.8 GB at its last full backup");
    // The internal address stays; api on de-fsn-1 loses it.
    await expect(notes).toContainText("Its internal address stays db:5432: services on us-ash-1 reach it there and reconnect by themselves");
    await expect(notes).toContainText("There is no private network between nodes");
    await expect(notes.getByText("api on de-fsn-1: DATABASE_URL")).toBeVisible();
    // The exposed port and the timed expose go to the new node's address; who reads EXPOSED_* needs a deploy.
    await expect(notes).toContainText("Its exposed port moves to 198.51.100.7:15432, with TLS and the same allowed IPs.");
    await expect(notes).toContainText("Its open timed expose moves to 198.51.100.7");
    await expect(notes).toContainText("These services read its EXPOSED_URL, EXPOSED_HOST or EXPOSED_PORT and get the new address on their next deploy");
    await expect(notes.getByText("worker on us-ash-1: PG_PUBLIC_URL")).toBeVisible();
    // Backups, with Back up now; the old copy.
    await expect(notes).toContainText("Its 2 backup schedules keep their times and run on us-ash-1");
    await expect(notes).toContainText("Back it up first");
    await expect(notes.getByRole("button", { name: "Back up now" })).toBeVisible();
    await expect(notes).toContainText("de-fsn-1 keeps its stopped copy until it runs on us-ash-1, then deletes it.");
    await page.screenshot({ path: `${shots}/move-card.png`, fullPage: true });

    // The dialog repeats the downtime and what asks something of you.
    await move.getByRole("button", { name: "Move", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: "Move db to us-ash-1?" })).toBeVisible();
    const asked = dialog.getByRole("list", { name: "Move db to us-ash-1?" });
    await expect(asked).toContainText("db stops while its data is copied to us-ash-1");
    await expect(asked.getByText("api on de-fsn-1: DATABASE_URL")).toBeVisible();
    await expect(asked).toContainText("These services read its EXPOSED_URL, EXPOSED_HOST or EXPOSED_PORT");
    await expect(asked.getByText("worker on us-ash-1: PG_PUBLIC_URL")).toBeVisible();
    await expect(asked.getByRole("button", { name: "Back up now" })).toBeVisible();
    await expect(asked).not.toContainText("keeps its stopped copy");
    // Its buttons stay on screen on a laptop.
    await expect(dialog.getByRole("button", { name: "Move", exact: true })).toBeInViewport();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/move-dialog.png` });

    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Moving db to us-ash-1")).toBeVisible();
    // A database has no Deployments tab: it stays here.
    await expect(page).toHaveURL(new RegExp(`/s/${svc.db}/advanced`));
    expect(sent).toEqual([{ serviceId: svc.db, toNodeId: ids.us }]);

    // On both nodes while it copies: the card stays, with the move and its log, and nothing to pick.
    await page.reload();
    await expect(move.getByText("db is moving to another node.")).toBeVisible();
    await expect(move.getByLabel("Move to")).toHaveCount(0);
    await expect(move.getByText("Cannot move to:")).toHaveCount(0);
    await page.screenshot({ path: `${shots}/moving.png`, fullPage: true });
    await move.getByRole("button", { name: "View log" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("while it moves the header says where, Cancel move asks first while it copies, and none once it starts there", async ({ page }) => {
    const worker = serviceHandlers["deployments.list"]?.({ serviceId: svc.worker }) as { deployments: Record<string, unknown>[] };
    const de = { id: ids.de, name: "de-fsn-1" };
    const us = { id: ids.us, name: "us-ash-1" };
    let move: Record<string, unknown> | null = {
      ...worker.deployments[0],
      id: "d000000000000097",
      serviceId: svc.db,
      status: "queued",
      trigger: "move",
      actor: "you@example.com",
      commit: null,
      source: null,
      builder: null,
      builtOn: null,
      move: { from: de, to: us, copying: true, canCancel: true },
    };
    const cancels: Record<string, unknown>[] = [];
    await installDemo(page, {
      overrides: {
        // As the move job leaves it while it copies: on both nodes, stopped.
        "services.get": (input) => {
          const base = serviceHandlers["services.get"]?.(input) as { placements: unknown[] };
          if (!move || input.serviceId !== svc.db) return base;
          return {
            ...base,
            status: "stopped",
            stopped: true,
            placements: [...base.placements, { nodeId: ids.us, nodeName: "us-ash-1", replicas: 1 }],
          };
        },
        "deployments.list": (input) =>
          input.serviceId === svc.db && String(input.active) === "true"
            ? { deployments: move ? [move] : [], nextCursor: null, keptImages: 0 }
            : serviceHandlers["deployments.list"]?.(input),
        "deployments.cancel": (input) => {
          cancels.push(input);
          const done = { ...move, status: "cancelled", move: { from: de, to: us, copying: false, canCancel: false } };
          move = null;
          return done;
        },
      },
    });
    await page.goto(`/p/${ids.acme}/s/${svc.db}/connection`);
    const header = page.locator("main header").first();
    await expect(header.getByRole("status")).toContainText("Moving to us-ash-1...");
    await expect(header.getByRole("status")).toHaveAttribute(
      "title",
      "It stops on de-fsn-1 while its data is copied to us-ash-1. Until the copy is done, Cancel move starts it again on de-fsn-1.",
    );
    // Nothing that would start, stop or cancel it some other way.
    for (const name of ["Cancel deploy", "Restart", "Stop", "Start"]) {
      await expect(header.getByRole("button", { name, exact: true })).toHaveCount(0);
    }
    await page.screenshot({ path: `${shots}/header-copying.png`, clip: (await header.boundingBox()) ?? undefined });
    // The menu has the same rule.
    await header.getByRole("button", { name: "More actions", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Cancel move" })).toBeVisible();
    for (const name of ["Cancel deploy", "Restart", "Start"]) await expect(page.getByRole("menuitem", { name, exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Cancel move says what happens; keeping it sends nothing.
    await header.getByRole("button", { name: "Cancel move", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: "Cancel moving db to us-ash-1?" })).toBeVisible();
    await expect(dialog).toContainText("The copy stops. db starts again on de-fsn-1 with its data, and us-ash-1 removes what was copied so far.");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/cancel-move-dialog.png` });
    await dialog.getByRole("button", { name: "Keep moving" }).click();
    await expect(dialog).toBeHidden();
    expect(cancels).toEqual([]);

    await header.getByRole("button", { name: "Cancel move", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel move", exact: true }).click();
    await expect(page.getByText("Move cancelled. db runs on de-fsn-1.")).toBeVisible();
    expect(cancels).toEqual([{ serviceId: svc.db, deploymentId: "d000000000000097" }]);
    await expect(header.getByRole("status")).toHaveCount(0);
    await expect(header.getByRole("button", { name: "Restart", exact: true })).toBeVisible();

    // Copied and starting on the new node: a cancel could lose what it writes there, so none is offered.
    move = {
      ...(worker.deployments[0] as object),
      id: "d000000000000096",
      serviceId: svc.db,
      status: "deploying",
      trigger: "move",
      move: { from: de, to: us, copying: false, canCancel: false },
    };
    await page.goto(`/p/${ids.acme}/s/${svc.db}/advanced`);
    await expect(header.getByRole("status")).toContainText("Moving to us-ash-1...");
    await expect(header.getByRole("status")).toHaveAttribute("title", /The move ends on its own: on us-ash-1 once it is healthy, or back on de-fsn-1 if it fails\.$/);
    await expect(header.getByRole("button", { name: "Cancel move", exact: true })).toHaveCount(0);
    await expect(header.getByRole("button", { name: "Cancel deploy", exact: true })).toHaveCount(0);
    await page.screenshot({ path: `${shots}/header-starting.png`, clip: (await header.boundingBox()) ?? undefined });
    await header.getByRole("button", { name: "More actions", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Open in new tab" })).toBeVisible();
    for (const name of ["Cancel move", "Cancel deploy"]) await expect(page.getByRole("menuitem", { name, exact: true })).toHaveCount(0);
  });

  test("a move that cannot start now says why, and the panel's refusal shows in the dialog", async ({ page }) => {
    let blocked = true;
    await installDemo(page, {
      overrides: {
        "services.moveImpact": (input) => ({
          ...moveImpactOf(String(input.serviceId)),
          blocker: blocked ? { reason: "backupRunning", message: "A backup of db is running. Move it once the backup ends." } : null,
        }),
        "services.move": () => {
          throw new DemoRefusal(
            409,
            "CONFLICT",
            "The agent on us-ash-1 cannot take connections without TLS yet (it needs 0.2.16), so clients without TLS would be refused there. Update the node first.",
            { reason: "agentTooOld", field: "toNodeId" },
          );
        },
      },
    });
    await page.goto(advanced);
    const move = page.locator("#move");
    await expect(move.getByText("A backup of db is running. Move it once the backup ends.")).toBeVisible();
    await move.getByLabel("Move to").click();
    await page.getByRole("option", { name: "us-ash-1", exact: true }).click();
    await expect(move.getByRole("button", { name: "Move", exact: true })).toBeDisabled();
    await page.screenshot({ path: `${shots}/blocked.png` });

    // The backup ended: the panel can still refuse the node, and the dialog says why.
    blocked = false;
    await page.reload();
    await move.getByLabel("Move to").click();
    await page.getByRole("option", { name: "us-ash-1", exact: true }).click();
    await move.getByRole("button", { name: "Move", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(dialog.getByText("cannot take connections without TLS yet (it needs 0.2.16)")).toBeVisible();
  });

  test("the database's menu has Move to another node, which opens the Move card", async ({ page }) => {
    await installDemo(page);
    await page.goto(`/p/${ids.acme}/s/${svc.db}/connection`);
    await page.locator("main header").first().getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Move to another node" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${svc.db}/advanced#move`));
    await expect(page.locator("#move")).toBeVisible();
  });

  test("Save and restart saves the limits, then restarts the database with them after a confirm", async ({ page }) => {
    const sent: string[] = [];
    const inputs: Record<string, unknown>[] = [];
    await installDemo(page, {
      overrides: {
        "services.setResources": (input) => {
          sent.push("services.setResources");
          inputs.push(input);
          const { serviceId: _, ...resources } = input;
          return resources;
        },
        "deployments.deploy": (input) => {
          sent.push("deployments.deploy");
          inputs.push(input);
          return { id: "d000000000000098", serviceId: input.serviceId, generation: 43, status: "queued", trigger: "manual" };
        },
      },
    });
    await page.goto(advanced);
    const main = page.getByRole("main");
    await main.getByLabel("Memory limit (MB)").fill("512");
    await main.getByRole("button", { name: "Save and restart" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: "Restart db with these limits?" })).toBeVisible();
    await expect(dialog).toContainText("offline for a few seconds; its data stays");
    expect(sent).toEqual([]);
    await dialog.getByRole("button", { name: "Save and restart" }).click();
    await expect(page.getByText("db restarts with the new limits")).toBeVisible();
    expect(sent).toEqual(["services.setResources", "deployments.deploy"]);
    expect(inputs[0]).toMatchObject({ serviceId: svc.db, memoryLimitBytes: 512_000_000 });
    expect(inputs[1]).toEqual({ serviceId: svc.db });
  });
});
