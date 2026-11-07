// Interop driver for scheduled cleanup and host shells: the real
// TypeScript panel (in process) against the real Go agent
// (TestInteropNodeOps, build tag "interop"). Through the panel's own ops,
// as the owner with a browser session, it sets a cleanup schedule and waits
// for the agent's disk-triggered CleanupRun to land in cleanup.runs, then
// allows host shells, opens one over the host shell WebSocket, runs
// hostname and exit, and checks the audit log and the security alert.
// Last, with host shells off again, it opens the agent's HostShell stream
// directly (skipping every panel check) to see the agent refuse on its own.
//
// Run from the repo root (host shells need Linux, so use the VM):
//
//   GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go -C go test -c -tags interop -o ../.vmbin/interop-nodeops.test ./internal/agent
//   SEYLO_INTEROP_VM_TEST=$PWD/.vmbin/interop-nodeops.test SEYLO_INTEROP_DIR=$PWD/.vmbin/interop-nodeops \
//     bun go/internal/agent/testdata/nodeops-interop-driver.ts
//
// SEYLO_INTEROP_DIR holds the panel data (under the folder the VM mounts);
// SEYLO_INTEROP_PORT (default 3133) is the panel port.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const root = resolve(import.meta.dir, "../../../../apps/panel");
const goDir = resolve(import.meta.dir, "../../..");
const work = process.env.SEYLO_INTEROP_DIR ?? "/tmp/seylo-interop-nodeops";
const { loadConfig } = await import(`${root}/src/config.ts`);
const { openDatabases } = await import(`${root}/src/db/client.ts`);
const { createLogger } = await import(`${root}/src/logger.ts`);
const { createPanel } = await import(`${root}/src/panel.ts`);
const { loadMasterKey } = await import(`${root}/src/security/master-key.ts`);
const { createSession } = await import(`${root}/src/auth/sessions.ts`);
const { sessionCookieName, sessionKeyHeader } = await import(`${root}/node_modules/@seylo/ops/src/index.ts`);
const { alerts, auditLog, joinTokens, users } = await import(`${root}/src/db/schema/index.ts`);
const { eq } = await import(`${root}/node_modules/drizzle-orm/index.js`);

const dataDir = join(work, "panel");
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const done = join(work, "done");
rmSync(done, { force: true });
const port = Number(process.env.SEYLO_INTEROP_PORT ?? 3133);
const base = `http://127.0.0.1:${port}`;
const config = loadConfig({ SEYLO_PORT: String(port), SEYLO_HOST: "127.0.0.1", SEYLO_DATA_DIR: dataDir, SEYLO_SECURE_COOKIES: "false", SEYLO_LOG_LEVEL: "warn" }, root);
const logger = createLogger("warn");
const panelPath = join(dataDir, "panel.db");
const masterKey = loadMasterKey(join(dataDir, "master.key"), !existsSync(panelPath));
const databases = openDatabases({ panelPath, metricsPath: join(dataDir, "metrics.db"), migrationsDir: config.migrationsDir });
const panel = createPanel({ config, databases, masterKey, logger });
panel.runner.start(panel.deps);
panel.app.listen({ hostname: "127.0.0.1", port });
const hub = panel.deps.agents;
const db = databases.db;

// The owner, signed in just now (fresh for host shells). A browser session
// is the cookie plus its key in a header (src/auth/sessions.ts); over plain
// HTTP with SECURE_COOKIES off the panel reads the plain cookie name, not
// the __Host- one.
const owner = db.insert(users).values({ email: "owner@example.com", name: "owner", role: "owner", passwordHash: null }).returning().get();
const { token: sessionToken, key: sessionKey } = createSession(db, owner.id, { ip: "127.0.0.1", userAgent: "interop" });
const sessionHeaders = { cookie: `${sessionCookieName(false)}=${sessionToken}`, [sessionKeyHeader]: sessionKey };
const op = async (id: string, input: Record<string, unknown>, method: "GET" | "POST" = "POST") => {
  const url = new URL(`/api/v1/${id}`, base);
  if (method === "GET") for (const [k, v] of Object.entries(input)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: { ...sessionHeaders, origin: base, "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(input) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
};

const joinToken = `seylo_join_${randomBytes(24).toString("base64url")}`;
db.insert(joinTokens).values({ tokenHash: createHash("sha256").update(joinToken).digest("hex"), expiresAt: new Date(Date.now() + 3600_000) }).run();

const results: string[] = [];
const ok = (m: string) => { results.push(`PASS ${m}`); console.log(`PASS ${m}`); };
const fail = (m: string, e?: unknown) => { results.push(`FAIL ${m} ${e ?? ""}`); console.log(`FAIL ${m}`, e ?? ""); };
const until = async (what: string, cond: () => boolean | Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await Bun.sleep(100); }
  fail(`timed out waiting for ${what}`);
  return false;
};
const online = new Promise<string>((resolve) => hub.onConnection((nodeId: string, up: boolean) => up && resolve(nodeId)));

const vmTest = process.env.SEYLO_INTEROP_VM_TEST;
const agentEnv = { SEYLO_INTEROP_PANEL_URL: `http://${vmTest ? "192.168.5.2" : "127.0.0.1"}:${port}`, SEYLO_INTEROP_TOKEN: joinToken, SEYLO_INTEROP_DONE: done };
const cmd = vmTest
  ? [resolve(goDir, "../scripts/dev/vm.sh"), `${Object.entries(agentEnv).map(([k, v]) => `${k}=${v}`).join(" ")} ${vmTest} -test.run TestInteropNodeOps -test.v -test.count=1`]
  : ["go", "test", "-race", "-count=1", "-tags", "interop", "-run", "TestInteropNodeOps", "-v", "./internal/agent/"];
const proc = Bun.spawn(cmd, { cwd: goDir, env: { ...process.env, ...agentEnv }, stdout: "pipe", stderr: "pipe" });
const goOut = new Response(proc.stdout).text();
const timer = setTimeout(() => { console.log("TIMEOUT"); process.exit(2); }, 240_000);

const nodeId = await online;
ok(`agent joined and is online as ${nodeId}`);
await Bun.sleep(500);

// Scheduled cleanup: the schedule reaches the agent, its disk trigger runs,
// and the durable CleanupRun lands in the run history.
try {
  const set = await op("cleanup.setSchedule", {
    nodeId,
    schedule: { enabled: true, cron: "0 4 * * *", diskPercent: 50, kinds: { images: true, buildCache: false, stoppedContainers: true, unusedVolumes: false } },
  });
  set.status === 200 ? ok(`cleanup.setSchedule -> next run ${set.body.nextRunAt}`) : fail(`cleanup.setSchedule ${set.status} ${JSON.stringify(set.body)}`);
  let runs: any[] = [];
  await until("the cleanup run", async () => {
    runs = (await op("cleanup.runs", { nodeId }, "GET")).body.runs ?? [];
    return runs.length > 0;
  });
  const run = runs[0];
  run?.trigger === "disk" && run.diskPercent === 95 && run.bytesFreed === 1 << 20 && run.status === "succeeded"
    ? ok(`cleanup run from the agent: ${run.trigger} ${run.diskPercent}% freed ${run.bytesFreed} (${run.removedCount} line)`)
    : fail(`cleanup run ${JSON.stringify(run)}`);
  const ran = db.select().from(alerts).where(eq(alerts.event, "cleanup_ran")).all();
  ran.length === 1 ? ok(`cleanup_ran alert: ${ran[0].title}`) : fail(`cleanup_ran alerts: ${ran.length}`);
} catch (e) { fail("cleanup", e); }

// Host shell through the panel.
try {
  const off = await op("hostShell.open", { nodeId });
  off.status === 409 && off.body.error?.details?.reason === "hostShellOff" ? ok("hostShell.open refused while off") : fail(`open while off ${off.status}`);
  const on = await op("hostShell.setEnabled", { nodeId, enabled: true });
  on.status === 200 ? ok("hostShell.setEnabled true (owner, fresh session)") : fail(`setEnabled ${on.status} ${JSON.stringify(on.body)}`);
  await panel.deps.agents.desired.settled();
  const ticket = await op("hostShell.open", { nodeId, columns: 100, rows: 30 });
  if (ticket.status !== 200) throw new Error(`open ${ticket.status} ${JSON.stringify(ticket.body)}`);
  const ws = new WebSocket(`ws://127.0.0.1:${port}${ticket.body.url}`);
  ws.binaryType = "arraybuffer";
  let text = "";
  const control: any[] = [];
  ws.onmessage = (e) => {
    if (typeof e.data === "string") control.push(JSON.parse(e.data));
    else text += new TextDecoder().decode(e.data as ArrayBuffer);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  await until("the ready message", () => control.some((m) => m.type === "ready"));
  const ready = control.find((m) => m.type === "ready");
  ready?.user === "root" ? ok(`host shell ready: user=${ready.user} workdir=${ready.workdir}`) : fail(`ready ${JSON.stringify(ready)}`);
  const facts = await hub.call(nodeId, "getNodeFacts", {});
  const host = facts.facts?.hostname ?? "";
  ws.send(new TextEncoder().encode("echo marker-$((6*7)); hostname; stty size\n"));
  await until("the shell output", () => text.includes("marker-42") && text.includes(host) && text.includes("30 100"));
  text.includes(host) ? ok(`host shell ran hostname on the node: ${host} (size 30 100)`) : fail(`output ${JSON.stringify(text)}`);
  ws.send(new TextEncoder().encode("exit 0\n"));
  await until("the exit", () => control.some((m) => m.type === "exit"));
  ok(`host shell exited: ${JSON.stringify(control.find((m) => m.type === "exit"))}`);
  await until("the close audit entry", () => db.select().from(auditLog).where(eq(auditLog.opId, "hostShell.close")).all().length === 1);
  const closed = db.select().from(auditLog).where(eq(auditLog.opId, "hostShell.close")).get();
  closed ? ok(`audit hostShell.close: ${JSON.stringify(closed.input)} by ${closed.actorLabel}`) : fail("no close audit entry");
  const opened = db.select().from(alerts).where(eq(alerts.event, "security_change")).all().filter((a: any) => a.title.includes("opened a root shell"));
  opened.length === 1 ? ok(`security alert: ${opened[0].title}`) : fail(`security alerts: ${opened.length}`);
} catch (e) { fail("host shell", e); }

// The agent refuses on its own once the setting is off, even when asked
// directly without any of the panel's checks.
try {
  await op("hostShell.setEnabled", { nodeId, enabled: false });
  await panel.deps.agents.desired.settled();
  await Bun.sleep(300);
  const s = hub.open(nodeId, "hostShell", { message: { case: "open", value: { size: { columns: 80, rows: 24 } } } });
  let refused = "";
  try {
    for await (const _ of s) { /* nothing expected */ }
    await s.done;
  } catch (e: any) { refused = `${e.code} ${e.message}`; }
  refused.includes("FORBIDDEN") ? ok(`agent refused a direct HostShell while off: ${refused}`) : fail(`agent did not refuse: ${refused || "opened"}`);
} catch (e) { fail("agent refusal", e); }

writeFileSync(done, "1");
const code = await proc.exited;
clearTimeout(timer);
const out = await goOut;
console.log(out.split("\n").filter((l) => /INTEROP|--- |^ok|FAIL|panic/.test(l)).join("\n"));
console.log(`go test exit ${code}`);
console.log(results.filter((r) => r.startsWith("FAIL")).length === 0 && code === 0 ? "ALL PASS" : "SOME FAILED");
await panel.app.stop(true);
process.exit(results.some((r) => r.startsWith("FAIL")) || code !== 0 ? 1 : 0);
