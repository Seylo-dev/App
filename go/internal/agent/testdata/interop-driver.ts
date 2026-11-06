// Interop driver: the real TypeScript panel (in process) against the real
// Go agent (TestInteropRealPanel, build tag "interop"). It joins the agent
// with a fresh token, then runs unary calls, server/bidi streams, raw
// uploads and downloads and a cancel from the panel side, and checks the
// agent's durable reports and state deltas arrive. Run from the repo root:
//
//   bun go/internal/agent/testdata/interop-driver.ts
//
// SEYLO_INTEROP_DIR (default /tmp/seylo-interop) holds the panel data;
// SEYLO_INTEROP_PORT (default 3132) is the panel port.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
const root = resolve(import.meta.dir, "../../../../apps/panel");
const goDir = resolve(import.meta.dir, "../../..");
const work = process.env.SEYLO_INTEROP_DIR ?? "/tmp/seylo-interop";
const { loadConfig } = await import(`${root}/src/config.ts`);
const { openDatabases } = await import(`${root}/src/db/client.ts`);
const { createLogger } = await import(`${root}/src/logger.ts`);
const { createPanel } = await import(`${root}/src/panel.ts`);
const { loadMasterKey } = await import(`${root}/src/security/master-key.ts`);
const { joinTokens, projects } = await import(`${root}/src/db/schema/index.ts`);
const { insertService } = await import(`${root}/src/modules/services/insert.ts`);

const dataDir = join(work, "panel");
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const done = join(work, "done");
rmSync(done, { force: true });
// The id of the service the driver places on the agent's node, for the
// agent's crash report and state delta: the hub drops reports about
// services that do not run on the reporting node.
const serviceFile = `${done}.service`;
rmSync(serviceFile, { force: true });
const port = Number(process.env.SEYLO_INTEROP_PORT ?? 3132);
const config = loadConfig({ SEYLO_PORT: String(port), SEYLO_HOST: "127.0.0.1", SEYLO_DATA_DIR: dataDir, SEYLO_SECURE_COOKIES: "false", SEYLO_LOG_LEVEL: "warn" }, root);
const logger = createLogger("warn");
const panelPath = join(dataDir, "panel.db");
const masterKey = loadMasterKey(join(dataDir, "master.key"), !existsSync(panelPath));
const databases = openDatabases({ panelPath, metricsPath: join(dataDir, "metrics.db"), migrationsDir: config.migrationsDir });
const panel = createPanel({ config, databases, masterKey, logger });
panel.runner.start(panel.deps);
panel.app.listen({ hostname: "127.0.0.1", port });
const hub = panel.deps.agents;

const token = `seylo_join_${randomBytes(24).toString("base64url")}`;
databases.db.insert(joinTokens).values({ tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 3600_000) }).run();

const results: string[] = [];
const ok = (m: string) => { results.push(`PASS ${m}`); console.log(`PASS ${m}`); };
const fail = (m: string, e?: unknown) => { results.push(`FAIL ${m} ${e ?? ""}`); console.log(`FAIL ${m}`, e ?? ""); };

const events: string[] = [];
hub.onEvent((nodeId: string, ev: any, meta: any) => events.push(`${ev.payload.case}${meta?.durable ? "(durable)" : ""}`));
let crashes = 0;
hub.onCrash(() => crashes++);
const online = new Promise<string>((resolve) => hub.onConnection((nodeId: string, up: boolean) => up && resolve(nodeId)));

// SEYLO_INTEROP_VM_TEST: a linux test binary (go test -c -tags interop) to
// run inside the test VM, which reaches the Mac's panel at 192.168.5.2. The
// work dir must then be under the folder the VM mounts.
const vmTest = process.env.SEYLO_INTEROP_VM_TEST;
const agentEnv = { SEYLO_INTEROP_PANEL_URL: `http://${vmTest ? "192.168.5.2" : "127.0.0.1"}:${port}`, SEYLO_INTEROP_TOKEN: token, SEYLO_INTEROP_DONE: done };
const cmd = vmTest
  ? [resolve(goDir, "../scripts/dev/vm.sh"), `${Object.entries(agentEnv).map(([k, v]) => `${k}=${v}`).join(" ")} ${vmTest} -test.run TestInteropRealPanel -test.v -test.count=1`]
  : ["go", "test", "-race", "-count=1", "-tags", "interop", "-run", "TestInteropRealPanel", "-v", "./internal/agent/"];
const proc = Bun.spawn(cmd, { cwd: goDir, env: { ...process.env, ...agentEnv }, stdout: "pipe", stderr: "pipe" });
const goOut = new Response(proc.stdout).text();
const timer = setTimeout(() => { console.log("TIMEOUT"); process.exit(2); }, 240_000);

const nodeId = await online;
ok(`agent joined and is online as ${nodeId}`);
const serviceId = databases.db.transaction((tx: any) => {
  const project = tx.insert(projects).values({ name: "interop", nameKey: "interop" }).returning({ id: projects.id }).get();
  return insertService(tx, { projectId: project.id, name: "interop-svc", kind: "app", nodeId }).id;
});
writeFileSync(serviceFile, serviceId);
ok(`placed service ${serviceId} on the node`);
await Bun.sleep(500);

try {
  const caps = [...(hub.capabilities(nodeId) ?? [])].sort();
  ok(`capabilities ${caps.join(",")}`);
  const facts = await hub.call(nodeId, "getNodeFacts", {});
  ok(`unary getNodeFacts -> hostname=${facts.facts?.hostname} os=${facts.facts?.os} kernel=${facts.facts?.kernel} arch=${facts.facts?.arch} cores=${facts.facts?.cpuCores} mem=${facts.facts?.memoryTotalBytes} boot=${facts.facts?.bootTime?.seconds}`);
  const snap = await hub.call(nodeId, "getStateSnapshot", {});
  ok(`unary getStateSnapshot -> epoch=${snap.snapshot?.epoch} seq=${snap.snapshot?.seq}`);
} catch (e) { fail("unary", e); }

try {
  const s = hub.open(nodeId, "logsFollow", { target: { case: "serviceId", value: "svc" }, tail: 3000 }, { initialWindow: 16 * 1024 });
  let n = 0, ordered = true;
  for await (const msg of s) { for (const e of msg.entries) { if (Number(e.generation) !== n) ordered = false; n++; } }
  await s.done;
  n === 3000 && ordered ? ok(`server stream logsFollow: 3000 messages (~690 KB) in order through a 16 KiB window`) : fail(`logsFollow got ${n} ordered=${ordered}`);
} catch (e) { fail("logsFollow", e); }

try {
  const s = hub.open(nodeId, "logsFollow", { target: { case: "serviceId", value: "follow-forever" }, tail: 5 });
  let n = 0;
  for await (const msg of s) { n += msg.entries.length; if (n >= 5) break; }
  const r = await s.done.then(() => "resolved", (e: any) => `rejected ${e?.details?.reason ?? e?.message}`);
  ok(`stream cancel by the panel (break after ${n}): done ${r}`);
} catch (e) { fail("stream cancel", e); }

try {
  const s = hub.open(nodeId, "shell", { message: { case: "open", value: {} } });
  const it = s[Symbol.asyncIterator]();
  const outs: string[] = [];
  for (const word of ["ls", "pwd"]) {
    await s.send({ message: { case: "input", value: new TextEncoder().encode(word) } });
    const r = await it.next();
    outs.push(new TextDecoder().decode((r.value as any).message.value));
  }
  s.closeSend();
  const exit = await it.next();
  await s.done;
  outs.join("|") === "echo:ls|echo:pwd" && (exit.value as any)?.message?.value === 7 ? ok(`bidi stream shell: ${outs.join(" ")} exit=7 after half-close`) : fail(`shell ${outs} ${JSON.stringify(exit.value)}`);
} catch (e) { fail("shell", e); }

try {
  const size = 5 * 1024 * 1024 + 17;
  const r = hub.openRaw(nodeId, "fsRead", { path: "big.bin", length: BigInt(size) });
  let got = 0, good = true;
  for await (const chunk of r.body!) {
    for (let i = 0; i < chunk.length; i += 4099) { const off = got + i; if (chunk[i] !== ((off * 7 + Math.floor(off / 1024)) & 0xff)) good = false; }
    got += chunk.length;
  }
  const resp = await r.response;
  got === size && good && Number(resp.info?.size) === size ? ok(`raw download fsRead: ${got} bytes, content checked, response size=${resp.info?.size}`) : fail(`fsRead got=${got} good=${good}`);
} catch (e) { fail("fsRead", e); }

try {
  const r = hub.openRaw(nodeId, "fsWrite", { path: "up.bin" });
  const h = createHash("sha256");
  let total = 0;
  for (let i = 0; i < 4; i++) { const b = randomBytes(1024 * 1024 + i); h.update(b); total += b.length; await r.writer!.write(b); }
  r.writer!.end();
  const resp = await r.response;
  const want = h.digest("hex");
  resp.info?.name === want && Number(resp.info?.size) === total ? ok(`raw upload fsWrite: ${total} bytes, sha256 matches on the agent`) : fail(`fsWrite ${resp.info?.name} vs ${want}`);
} catch (e) { fail("fsWrite", e); }

try {
  await hub.call(nodeId, "fsList", { path: "/" });
  fail("fsList should be NOT_FOUND");
} catch (e: any) { ok(`agent status mapping: fsList -> ${e.code} (${e.details?.reason}/${e.details?.agentStatus}) "${e.message}"`); }

await Bun.sleep(300);
const durable = events.filter((e) => e.includes("durable"));
durable.some((e) => e.startsWith("nodeAlert")) ? ok(`agent -> panel ReportEvent: ${durable.join(",")}`) : fail(`no durable nodeAlert; events=${events.join(",")}`);
events.some((e) => e.startsWith("stateDelta")) ? ok(`agent -> panel best-effort stateDelta event received`) : fail(`no stateDelta; events=${events.join(",")}`);
crashes === 1 ? ok(`crash report for the placed service reached the crash listener`) : fail(`crash listener calls: ${crashes}, want 1`);

const st = hub.state.get(nodeId);
st?.services?.has(serviceId)
  ? ok(`node state: online=${st?.online} synced=${st?.synced} services=${[...st.services.keys()]}`)
  : fail(`node state has no ${serviceId}: ${[...(st?.services?.keys() ?? [])]}`);

writeFileSync(done, "1");
const code = await proc.exited;
clearTimeout(timer);
const out = await goOut;
console.log(out.split("\n").filter((l) => /INTEROP|--- |^ok|FAIL|panic/.test(l)).join("\n"));
console.log(`go test exit ${code}`);
console.log(results.filter((r) => r.startsWith("FAIL")).length === 0 && code === 0 ? "ALL PASS" : "SOME FAILED");
await panel.app.stop(true);
process.exit(results.some((r) => r.startsWith("FAIL")) || code !== 0 ? 1 : 0);
