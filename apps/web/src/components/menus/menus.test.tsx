import { describe, expect, mock, test } from "bun:test";
import { entryIds, type MenuEntry, menuElements } from "@seylo/ui/components/menu-items";
import type { ReactElement } from "react";
import { t } from "../../i18n/t";
import { nodeMenuEntries } from "./node-items";
import { projectMenuEntries } from "./project-items";
import {
  alertCheckMenuEntries,
  backupPolicyMenuEntries,
  backupRunMenuEntries,
  chatMenuEntries,
  cronJobMenuEntries,
  type DomainMenuSubject,
  databaseUserMenuEntries,
  deploymentMenuEntries,
  domainMenuEntries,
} from "./row-items";
import { serviceMenuEntries } from "./service-items";

type Item = Extract<MenuEntry, { type: "item" }>;
const act = () => {};
const find = (entries: MenuEntry[], id: string) => entries.find((e) => e.type === "item" && e.id === id) as Item | undefined;

describe("project", () => {
  const project = { id: "projshop00000001", name: "shop", protected: false, collapsed: false, serviceCount: 0 };
  const ids = (change: Partial<typeof project> = {}, ctx: { here?: boolean; hidden?: boolean } = {}) =>
    entryIds(projectMenuEntries({ ...project, ...change }, { here: false, hidden: false, act, ...ctx }));

  test("an empty project offers everything, in this order", () => {
    const list = ids();
    expect(list.slice(0, 3)).toEqual(["open", "openNewTab", "newService"]);
    expect(list.filter((id) => !id.startsWith("new:"))).toEqual([
      "open",
      "openNewTab",
      "newService",
      "rename",
      "collapse",
      "hide",
      "settings",
      "copyId",
      "delete",
    ]);
    // New service lists every kind of the New service menu.
    expect(list).toEqual(expect.arrayContaining(["new:app", "new:database", "new:compose", "new:template", "new:import"]));
  });

  test("the protected Panel project takes no new services and is not renamed or deleted", () => {
    const list = ids({ protected: true });
    for (const id of ["newService", "new:app", "rename", "delete"]) expect(list).not.toContain(id);
    expect(list).toEqual(expect.arrayContaining(["collapse", "hide", "copyId"]));
  });

  test("a project with services: Delete waits, with the Settings tab's reason", () => {
    const entries = projectMenuEntries({ ...project, serviceCount: 2 }, { here: false, hidden: false, act });
    expect(find(entries, "delete")?.disabled).toBe(true);
    expect(find(entries, "delete")?.disabledReason).toBe(t("project.deleteHasServices"));
    expect(find(entries, "delete")?.destructive).toBe(true);
  });

  test("Hide or Unhide, Collapse or Expand, by its state; no Open on its own page", () => {
    expect(ids({}, { hidden: true })).toContain("unhide");
    expect(ids({}, { hidden: true })).not.toContain("hide");
    const hidden = projectMenuEntries(project, { here: false, hidden: true, act });
    expect(find(hidden, "unhide")?.label).toBe(t("sidebar.unhideProject"));
    expect(find(projectMenuEntries(project, { here: false, hidden: false, act }), "hide")?.label).toBe(t("sidebar.hideProject"));
    expect(ids({ collapsed: true })).toContain("expand");
    expect(ids({ collapsed: true })).not.toContain("collapse");
    expect(ids({}, { here: true })).not.toContain("open");
  });

  test("a New service kind says which", () => {
    const pick = mock();
    const entries = projectMenuEntries(project, { here: false, hidden: false, act: pick });
    const sub = entries.find((e) => e.id === "newService") as Extract<MenuEntry, { type: "sub" }>;
    (sub.entries.find((e) => e.id === "new:database") as Item).onSelect();
    expect(pick.mock.calls).toEqual([["new:database"]]);
  });
});

describe("node", () => {
  const node = {
    id: "nodedefsn1000001",
    name: "de-fsn-1",
    status: "online" as const,
    updateAvailable: false,
    publicAddress: null,
    publicIpv4: "203.0.113.10",
    publicIpv6: null,
  };

  test("an online node: the sheet's views, Run health checks and its address", () => {
    expect(entryIds(nodeMenuEntries(node, { updatePending: false, act }))).toEqual([
      "open",
      "health",
      "runHealthChecks",
      "shell",
      "cleanup",
      "settings",
      "copyIpv4",
      "copyId",
    ]);
  });

  test("Update now as the row's button: only with an update, waiting while one runs or the node is offline", () => {
    const update = (change: Partial<typeof node>, updatePending = false) =>
      find(nodeMenuEntries({ ...node, updateAvailable: true, ...change }, { updatePending, act }), "update");
    expect(update({})?.disabled).toBeUndefined();
    expect(update({}, true)?.disabled).toBe(true);
    expect(update({ status: "offline" as never })?.disabled).toBe(true);
    expect(find(nodeMenuEntries(node, { updatePending: false, act }), "update")).toBeUndefined();
  });

  test("an offline node: Run health checks waits, with why", () => {
    const entries = nodeMenuEntries({ ...node, status: "offline" as never }, { updatePending: false, act });
    expect(find(entries, "runHealthChecks")?.disabled).toBe(true);
    expect(find(entries, "runHealthChecks")?.disabledReason).toBe(t("menus.nodeOffline"));
  });

  test("each address it has, the name once when it is an IP", () => {
    const all = entryIds(
      nodeMenuEntries({ ...node, publicAddress: "de1.example.com", publicIpv6: "2001:db8::1" }, { updatePending: false, act }),
    );
    expect(all).toEqual(expect.arrayContaining(["copyAddress", "copyIpv4", "copyIpv6"]));
    expect(entryIds(nodeMenuEntries({ ...node, publicAddress: "203.0.113.10" }, { updatePending: false, act }))).not.toContain(
      "copyAddress",
    );
    const none = entryIds(nodeMenuEntries({ ...node, publicIpv4: null }, { updatePending: false, act }));
    expect(none.filter((id) => id.startsWith("copy"))).toEqual(["copyId"]);
  });
});

describe("deployment row", () => {
  const d = { id: "d000000000000010", commit: { sha: "7f02b1d000" }, canRollback: true, running: false };
  test("with a commit: View log, both Redeploys, Roll back, and the commit to copy", () => {
    expect(entryIds(deploymentMenuEntries(d, { busy: false, act }))).toEqual([
      "viewLog",
      "redeployCommit",
      "redeployNoCache",
      "rollback",
      "copyCommit",
      "copyId",
    ]);
  });
  test("an image deploy has no commit, an old one no rollback, a running one Cancel deploy", () => {
    const list = entryIds(deploymentMenuEntries({ ...d, commit: null, canRollback: false, running: true }, { busy: true, act }));
    expect(list).toEqual(["viewLog", "redeployNoCache", "cancel", "copyId"]);
  });
  test("a running move to another node: Cancel move while the panel takes one, else nothing to cancel (0.2.16)", () => {
    const move = { ...d, commit: null, canRollback: false, running: true };
    const entries = deploymentMenuEntries({ ...move, move: { canCancel: true } }, { busy: true, act });
    expect(entryIds(entries)).toEqual(["viewLog", "redeployNoCache", "cancelMove", "copyId"]);
    expect(find(entries, "cancelMove")?.label).toBe(t("service.header.cancelMove"));
    expect(entryIds(deploymentMenuEntries({ ...move, move: { canCancel: false } }, { busy: true, act }))).toEqual([
      "viewLog",
      "redeployNoCache",
      "copyId",
    ]);
  });
  test("while a deploy runs, Redeploy and Roll back wait with the header's reason; the labels are the row's", () => {
    const entries = deploymentMenuEntries(d, { busy: true, act });
    for (const id of ["redeployCommit", "redeployNoCache", "rollback"]) {
      expect(find(entries, id)?.disabled).toBe(true);
      expect(find(entries, id)?.disabledReason).toBe(t("service.header.deployBusyHint"));
    }
    expect(find(entries, "redeployNoCache")?.label).toBe(t("serviceDeploys.redeployNoCache"));
    expect(find(entries, "rollback")?.label).toBe(t("serviceDeploys.rollback"));
  });
});

describe("domain row", () => {
  const d: DomainMenuSubject = { forward: null, auto: false, primary: false };
  const ids = (change: Partial<typeof d> = {}, ctx: { linkable?: boolean; canRegenerate?: boolean } = {}) =>
    entryIds(domainMenuEntries({ ...d, ...change }, { linkable: true, canRegenerate: false, regenerating: false, act, ...ctx }));
  test("a served custom domain", () => {
    expect(ids()).toEqual(["openNewTab", "routing", "access", "certificate", "primary", "copyDomain", "remove"]);
  });
  test("a forward has no access rules and is never primary; an automatic one has no certificate to upload", () => {
    expect(ids({ forward: { url: "https://x" } })).toEqual(["openNewTab", "routing", "certificate", "copyDomain", "remove"]);
    expect(ids({ auto: true, primary: true })).toEqual(["openNewTab", "routing", "access", "copyDomain", "remove"]);
  });
  test("Regenerate when the certificate can be, waiting while it runs; no Open in new tab while it is not served", () => {
    expect(ids({}, { canRegenerate: true, linkable: false })).toEqual([
      "routing",
      "access",
      "certificate",
      "regenerate",
      "primary",
      "copyDomain",
      "remove",
    ]);
    const busy = domainMenuEntries(d, { linkable: true, canRegenerate: true, regenerating: true, act });
    expect(find(busy, "regenerate")?.disabled).toBe(true);
  });
});

describe("the other rows keep their menus", () => {
  test("backups, cron, uptime checks and chats", () => {
    expect(entryIds(backupPolicyMenuEntries({ act }))).toEqual(["runNow", "edit", "remove"]);
    // A run's items come from backups/run-row.tsx runMenu (tested there); these are their labels.
    const runItems = backupRunMenuEntries(["restore", "download", "remove"], { act });
    expect(entryIds(runItems)).toEqual(["restore", "download", "remove"]);
    expect(runItems.map((e) => (e.type === "item" ? e.label : ""))).toEqual([
      t("serviceBackups.restore"),
      t("serviceBackups.download"),
      t("service.remove"),
    ]);
    expect(find(runItems, "remove")?.destructive).toBe(true);
    // Its destination deleted: only Remove from list.
    const forget = backupRunMenuEntries(["forget"], { act });
    expect(find(forget, "forget")).toMatchObject({ label: t("serviceBackups.forgetRun"), destructive: true });
    // No items, no menu.
    expect(backupRunMenuEntries([], { act })).toEqual([]);
    expect(entryIds(cronJobMenuEntries({ act }))).toEqual(["runNow", "edit", "remove"]);
    const paused = alertCheckMenuEntries({ enabled: false }, { act });
    expect(find(paused, "toggle")?.label).toBe(t("serviceAlerts.resume"));
    expect(find(alertCheckMenuEntries({ enabled: true }, { act }), "toggle")?.label).toBe(t("serviceAlerts.pause"));
    expect(entryIds(chatMenuEntries({ act }))).toEqual(["rename", "delete"]);
  });

  test("a database user: what the panel says it cannot do is there but disabled, and its why closes the menu", () => {
    const user = { can: { passwordChange: true, rename: false, makeMain: false, delete: false }, why: "It owns tables." };
    const entries = databaseUserMenuEntries(user, { canSwitch: true, act });
    expect(entryIds(entries)).toEqual(["password", "rename", "makeMain", "copyName", "delete"]);
    expect(find(entries, "password")?.disabled).toBe(false);
    expect(find(entries, "rename")?.disabled).toBe(true);
    expect(find(entries, "delete")?.disabled).toBe(true);
    expect(entries.at(-1)).toEqual({ type: "label", id: "why", label: "It owns tables." });
    // An engine without a main-user switch has no Make main.
    expect(entryIds(databaseUserMenuEntries({ ...user, why: null }, { canSwitch: false, act }))).not.toContain("makeMain");
  });
});

/** The data-menu-id of every item, sub menus' items after their trigger: what a person can choose. */
function chosen(elements: readonly ReactElement[]): string[] {
  return elements.flatMap((element) => {
    const props = element.props as { "data-menu-id"?: string; children?: unknown };
    const own = props["data-menu-id"] ? [props["data-menu-id"]] : [];
    const kids = (Array.isArray(props.children) ? props.children : [props.children]).flat(2) as unknown[];
    const nested = kids.filter((kid): kid is ReactElement => typeof kid === "object" && kid !== null && "props" in kid);
    return [...own, ...chosen(nested)];
  });
}

describe("the '...' menu and the right-click menu list the same items", () => {
  const service = {
    id: "svcapi000000002a",
    projectId: "projacmeshop0001",
    name: "api",
    kind: "app" as const,
    parentId: null,
    status: "running" as const,
    address: "api.example.com",
    protected: false,
    placements: [{ nodeId: "n", nodeName: "n", replicas: 1 }],
  };
  const fixtures: [string, MenuEntry[]][] = [
    ["service", serviceMenuEntries(service, { here: false, busy: false, terminalModes: ["console"], act })],
    ["busy service", serviceMenuEntries({ ...service, status: "building" }, { here: true, busy: true, terminalModes: [], act })],
    [
      "project",
      projectMenuEntries({ id: "p", name: "p", protected: false, collapsed: false, serviceCount: 1 }, { here: false, hidden: false, act }),
    ],
    [
      "node",
      nodeMenuEntries(
        { id: "n", name: "n", status: "online", updateAvailable: true, publicAddress: null, publicIpv4: "1.2.3.4", publicIpv6: null },
        { updatePending: false, act },
      ),
    ],
    ["deployment", deploymentMenuEntries({ id: "d", commit: { sha: "abc1234" }, canRollback: true, running: true }, { busy: true, act })],
    [
      "domain",
      domainMenuEntries({ forward: null, auto: false, primary: false }, { linkable: true, canRegenerate: true, regenerating: false, act }),
    ],
    [
      "database user",
      databaseUserMenuEntries(
        { can: { passwordChange: true, rename: true, makeMain: true, delete: false }, why: "why" },
        { canSwitch: true, act },
      ),
    ],
  ];
  test.each(fixtures)("%s", (_name, entries) => {
    const dropdown = chosen(menuElements("dropdown", entries));
    expect(dropdown.length).toBeGreaterThan(0);
    expect(chosen(menuElements("context", entries))).toEqual(dropdown);
    expect(dropdown).toEqual(entryIds(entries));
  });
});
