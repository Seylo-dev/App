// The Overview's console card watches (terminals.watchConsole): a ticket for
// the console's output only, which drops what the viewer sends and is not in
// the audit log, unlike terminals.console, which is.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { projects, services as serviceOps, terminals } from "@seylo/ops";
import { auditLog } from "../src/db/schema";
import { startTerminal, type TerminalTicket } from "../src/modules/terminals";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let cookie: string;
let serviceId: string;

beforeEach(async () => {
  panel = testPanel();
  const fleet = new FakeFleet(panel);
  const nodeId = fleet.addNode("node-a", { panelNode: true });
  ({ cookie } = await createUser(panel, "owner"));
  const projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
  serviceId = (
    await callOp(
      panel,
      serviceOps.create,
      { projectId, name: "web", kind: "app", nodeId, source: { type: "image", image: "nginx:1.27", registryId: null } },
      { cookie },
    )
  ).body.id;
});
afterEach(() => panel.close());

const auditedOps = () =>
  panel.deps.db
    .select()
    .from(auditLog)
    .all()
    .map((row) => row.opId)
    .filter((op) => op.startsWith("terminals."));

test("watching the console is not audited; opening it to type is", async () => {
  const watched = await callOp(panel, terminals.watchConsole, { serviceId, tail: 200 }, { cookie });
  expect(watched.status).toBe(200);
  expect(watched.body.url).toContain("?t=");
  expect(auditedOps()).toEqual([]);
  expect((await callOp(panel, terminals.openConsole, { serviceId, tail: 200 }, { cookie })).status).toBe(200);
  expect(auditedOps()).toEqual(["terminals.console"]);
});

test("a member needs terminals.console to watch it too", async () => {
  const member = await createUser(panel, "member");
  expect((await callOp(panel, terminals.watchConsole, { serviceId }, { cookie: member.cookie })).status).toBe(403);
});

test("a watch session passes output on and drops what the viewer sends", async () => {
  const sent: unknown[] = [];
  const never = new Promise<never>(() => {});
  const stream = {
    [Symbol.asyncIterator]: () => ({ next: () => never }),
    done: never,
    cancel: () => {},
    send: async (message: unknown) => void sent.push(message),
  };
  const deps = { agents: { open: () => stream } } as unknown as Parameters<typeof startTerminal>[0];
  const ticket: TerminalTicket = {
    mode: "console",
    serviceId: "s",
    nodeId: "n",
    containerId: "c",
    generation: 1,
    tail: 100,
    command: [],
    user: "",
    databaseClient: false,
    columns: 80,
    rows: 24,
  };
  const socket = { sendBytes: () => {}, sendControl: () => {}, close: () => {} };
  const watch = startTerminal(deps, { ...ticket, watch: true }, socket);
  watch.input(new TextEncoder().encode("rm -rf /\n"));
  expect(sent).toEqual([]);
  watch.stop();
  const full = startTerminal(deps, ticket, socket);
  full.input(new TextEncoder().encode("stats\n"));
  expect(sent).toHaveLength(1);
  full.stop();
});
