import { describe, expect, mock, test } from "bun:test";
import { entryIds, type MenuEntry } from "@seylo/ui/components/menu-items";
import { t } from "../../i18n/t";
import { panelServiceId } from "../../lib/service-display";
import { type ServiceMenuContext, type ServiceMenuSubject, serviceMenuEntries } from "./service-items";

const base: ServiceMenuSubject = {
  id: "svcapi000000002a",
  projectId: "projacmeshop0001",
  name: "api",
  kind: "app",
  parentId: null,
  status: "running",
  address: "api.example.com",
  protected: false,
  placements: [{ nodeId: "nodedefsn1000001", nodeName: "de-fsn-1", replicas: 1 }],
};
const ctx: ServiceMenuContext = { here: false, busy: false, terminalModes: ["console", "shell"], act: () => {} };
const ids = (service: Partial<ServiceMenuSubject>, change: Partial<ServiceMenuContext> = {}) =>
  entryIds(serviceMenuEntries({ ...base, ...service }, { ...ctx, ...change }));
const item = (entries: MenuEntry[], id: string) => entries.find((e) => e.id === id) as Extract<MenuEntry, { type: "item" }> | undefined;

describe("a running app", () => {
  test("offers everything, in this order", () => {
    expect(ids({})).toEqual([
      "open",
      "openNewTab",
      "deploy",
      "restart",
      "stop",
      "logs",
      "console",
      "clone",
      "moveProject",
      "moveNode",
      "copyAddress",
      "copyId",
      "delete",
    ]);
  });

  test("the labels are the header's and the old service menu's", () => {
    const entries = serviceMenuEntries(base, ctx);
    expect(item(entries, "deploy")?.label).toBe(t("service.header.deploy"));
    expect(item(entries, "restart")?.label).toBe(t("service.header.restart"));
    expect(item(entries, "clone")?.label).toBe(t("serviceCopy.menu.clone"));
    expect(item(entries, "moveProject")?.label).toBe(t("serviceCopy.menu.moveProject"));
    expect(item(entries, "delete")?.destructive).toBe(true);
  });

  test("choosing an item says which", () => {
    const act = mock();
    const entries = serviceMenuEntries(base, { ...ctx, act });
    item(entries, "clone")?.onSelect();
    item(entries, "copyId")?.onSelect();
    expect(act.mock.calls).toEqual([["clone"], ["copyId"]]);
  });

  test("on its own page there is no Open (Open in new tab stays)", () => {
    expect(ids({}, { here: true }).slice(0, 2)).toEqual(["openNewTab", "deploy"]);
  });
});

test("stopped: Start instead of Restart and Stop", () => {
  const list = ids({ stopped: true, status: "stopped" });
  expect(list).toContain("start");
  expect(list).not.toContain("restart");
  expect(list).not.toContain("stop");
});

test("a list row has no desired state: status stopped stands in for it", () => {
  expect(ids({ status: "stopped" })).toContain("start");
  // services.get's stopped (from the cache) wins over the status.
  expect(ids({ status: "crashed" }, { stopped: true })).toContain("start");
  expect(ids({ status: "crashed" })).toEqual(expect.arrayContaining(["restart", "stop"]));
});

test("idle (never ran): neither Restart nor Stop nor Start", () => {
  const list = ids({ status: "idle" });
  for (const id of ["restart", "stop", "start"]) expect(list).not.toContain(id);
  expect(list).toContain("deploy");
});

test("while a deploy runs: Cancel deploy, and Deploy waits with the header's reason", () => {
  const entries = serviceMenuEntries({ ...base, status: "building" }, { ...ctx, busy: true });
  const list = entryIds(entries);
  expect(list).toContain("cancelDeploy");
  expect(list).not.toContain("restart");
  expect(list).not.toContain("stop");
  expect(item(entries, "deploy")?.disabled).toBe(true);
  expect(item(entries, "deploy")?.disabledReason).toBe(t("service.header.deployBusyHint"));
});

test("the panel's own service: no Deploy, Stop, Clone, Move or Delete", () => {
  const list = ids({ id: panelServiceId, protected: true });
  for (const id of ["deploy", "stop", "clone", "moveProject", "moveNode", "delete", "cancelDeploy"]) expect(list).not.toContain(id);
  expect(list).toContain("restart");
  // Busy never applies: the panel does not deploy.
  expect(ids({ id: panelServiceId, protected: true }, { busy: true })).not.toContain("cancelDeploy");
});

test("a protected service (the Panel project's): no Clone, Move to project or Delete", () => {
  const list = ids({ protected: true });
  for (const id of ["clone", "moveProject", "delete"]) expect(list).not.toContain(id);
  expect(list).toContain("deploy");
});

test("a compose stack: no Clone or Move, no Logs or Console (its page has neither), and Delete takes the stack", () => {
  const list = ids({ kind: "compose" });
  for (const id of ["clone", "moveProject", "moveNode", "logs", "console", "deploy"]) expect(list).not.toContain(id);
  expect(list).toContain("delete");
});

test("a compose member moves with its stack and is deleted with it", () => {
  const list = ids({ parentId: "svcstack00000001" });
  expect(list).toContain("clone");
  expect(list).not.toContain("moveProject");
  expect(list).not.toContain("delete");
});

test("a database: Logs but no Deploy or Console, and no Move to another node (no Advanced tab)", () => {
  const list = ids({ kind: "postgres", address: "db:5432", name: "db" });
  expect(list).toContain("logs");
  for (const id of ["deploy", "console", "moveNode", "copyAddress"]) expect(list).not.toContain(id);
  expect(list).toContain("copyInternalAddress");
});

test("a Box: Stop and Open editor, as its header", () => {
  const list = ids({ kind: "box" });
  expect(list).toEqual(expect.arrayContaining(["stopBox", "openBox", "logs"]));
  for (const id of ["deploy", "restart", "stop", "console"]) expect(list).not.toContain(id);
});

test("a cron service deploys but has no console", () => {
  const list = ids({ kind: "cron", address: null });
  expect(list).toContain("deploy");
  expect(list).not.toContain("console");
});

test("Console only with a terminal mode the viewer may open", () => {
  expect(ids({}, { terminalModes: [] })).not.toContain("console");
  expect(ids({}, { terminalModes: null })).not.toContain("console");
  expect(ids({}, { terminalModes: ["shell"] })).toContain("console");
});

test("the address to copy: none without one, the internal name:port as such", () => {
  const none = ids({ address: null });
  expect(none).not.toContain("copyAddress");
  expect(none).not.toContain("copyInternalAddress");
  expect(ids({ address: "api:8080" })).toContain("copyInternalAddress");
});

test("Move to another node only for a service on one node", () => {
  expect(
    ids({
      placements: [
        { nodeId: "a", nodeName: "a", replicas: 1 },
        { nodeId: "b", nodeName: "b", replicas: 1 },
      ],
    }),
  ).not.toContain("moveNode");
});
