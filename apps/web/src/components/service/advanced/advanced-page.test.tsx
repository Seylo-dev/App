import { expect, test } from "bun:test";
import { deployments, services } from "@seylo/ops";
import { t } from "../../../i18n/t";
import { renderStatic } from "../../../test/render";
import type { ServiceDetail } from "../use-service";
import { AdvancedPage } from "./advanced-page";
import type { MoveImpact } from "./move-notes";

const node = (id: string, name: string, over: Partial<MoveImpact["targets"][number]> = {}) => ({
  id,
  name,
  online: true,
  address: "203.0.113.20",
  refusal: null,
  ...over,
});
const impact = (change: Partial<MoveImpact> = {}): MoveImpact => ({
  blocker: null,
  targets: [
    node("nodeb00000000002", "us-ash-1"),
    node("nodec00000000003", "il-tlv-1", {
      refusal: {
        reason: "agentTooOld",
        message: "The agent on il-tlv-1 cannot keep PostgreSQL's exposed port TLS only yet, so the port would close there.",
      },
    }),
    node("noded00000000004", "nl-ams-1", {
      online: false,
      refusal: { reason: "offline", message: "nl-ams-1 is offline; volumes can only be copied between online nodes." },
    }),
  ],
  volumes: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
  dataSize: null,
  lastBackupAt: null,
  backupSchedules: 0,
  exposure: { database: null, timed: 0, firstRun: false },
  exposedReferrers: [],
  internalReferrers: [],
  hiddenReferrers: 0,
  ...change,
});

const service = (kind: string) =>
  ({
    id: "svcdb0000000003a",
    projectId: "projacmeshop0001",
    name: "db",
    kind,
    address: "db:5432",
    placements: [{ nodeId: "nodea00000000001", nodeName: "de-fsn-1", replicas: 1 }],
    crashPolicy: { restart: true, stopAfterCrashes: 0 },
    restartDelaySeconds: 5,
    resources: { memoryLimitBytes: null, memoryReservationBytes: null, cpuWeight: null, pidsLimit: null },
    healthCheck: null,
    deploy: { mode: "recreate", healthTimeoutSeconds: 60 },
    ports: [{ containerPort: 5432, protocol: "tcp" }],
    container: { command: [], entrypoint: [], workingDir: "", user: "", stopSignal: "", stopGraceSeconds: 10, init: "auto" },
    volumes: [],
    stickySessions: false,
    entryNodeId: null,
  }) as unknown as ServiceDetail;

const page = (kind: string, answer = impact(), over: Partial<ServiceDetail> = {}, active: unknown[] = []) =>
  renderStatic(
    () => <AdvancedPage service={{ ...service(kind), ...over }} />,
    [
      [services.moveImpact, { serviceId: "svcdb0000000003a" }, answer],
      [deployments.list, { serviceId: "svcdb0000000003a", active: true, limit: 1 }, { deployments: active }],
    ],
  ).then((html) => html.replace(/&#x27;/g, "'"));

test("a database's Advanced tab: Move to another node, its limits with a restart, and its crash policy; nothing the engine manages", async () => {
  const out = await page("postgres");
  expect(out).toContain(t("serviceAdvanced.move.title"));
  expect(out).toContain(t("serviceAdvanced.move.databaseDescription"));
  expect(out).toContain(`id="move"`);
  expect(out).toContain(t("serviceAdvanced.resources.title"));
  expect(out).toContain(t("serviceAdvanced.resources.saveAndRestart"));
  expect(out).toContain(t("serviceAdvanced.resources.restartHint"));
  expect(out).not.toContain(t("serviceAdvanced.nextDeploy"));
  expect(out).toContain(t("serviceAdvanced.crash.title"));
  for (const left of ["health.title", "placement.title", "container.title", "container.ports"] as const) {
    expect(out).not.toContain(t(`serviceAdvanced.${left}`));
  }
  // The move first.
  expect(out.indexOf(t("serviceAdvanced.move.title"))).toBeLessThan(out.indexOf(t("serviceAdvanced.resources.title")));
});

test("a database's Command card shows the command it runs, saved with a restart, with its engine's hint", async () => {
  const command = ["mariadbd", "--max-connections=5000", "--thread-handling=pool-of-threads"];
  const out = await page("mariadb", impact(), { container: { ...service("mariadb").container, command } });
  expect(out).toContain(t("serviceAdvanced.dbCommand.title"));
  expect(out).toContain(t("serviceAdvanced.dbCommand.description"));
  expect(out).toContain(`value="mariadbd --max-connections=5000 --thread-handling=pool-of-threads"`);
  expect(out).toContain(t("serviceAdvanced.dbCommand.examples.mariadb"));
  expect(out).toContain(t("serviceAdvanced.dbCommand.restartHint"));
  // Between the limits and the crash policy.
  const at = out.indexOf(t("serviceAdvanced.dbCommand.description"));
  expect(out.indexOf(t("serviceAdvanced.resources.title"))).toBeLessThan(at);
  expect(at).toBeLessThan(out.indexOf(t("serviceAdvanced.crash.title")));

  // The image's own command: an empty field that says so.
  const own = await page("postgres");
  expect(own).toContain(`placeholder="${t("serviceAdvanced.dbCommand.emptyImage")}"`);
  expect(own).toContain(t("serviceAdvanced.dbCommand.examples.postgres"));

  // Redis says what must stay; MySQL with mysql_native_password on says to keep it.
  const redis = await page("redis", impact(), {
    container: {
      ...service("redis").container,
      command: ["sh", "-c", 'exec redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes'],
    },
  });
  expect(redis).toContain(t("serviceAdvanced.dbCommand.examples.redis").replace(/"/g, "&quot;"));
  const mysql = await page("mysql", impact(), {
    container: { ...service("mysql").container, command: ["mysqld", "--mysql-native-password=ON"] },
  });
  expect(mysql).toContain(t("serviceAdvanced.dbCommand.nativePassword"));
  expect(own).not.toContain(t("serviceAdvanced.dbCommand.nativePassword"));
});

test("the Move card says why a node cannot take it", async () => {
  const out = await page("postgres");
  expect(out).toContain(t("serviceAdvanced.move.cannotGo"));
  expect(out).toContain("The agent on il-tlv-1 cannot keep PostgreSQL's exposed port TLS only yet, so the port would close there.");
  expect(out).toContain("nl-ams-1 is offline; volumes can only be copied between online nodes.");
});

test("a move that cannot start now says why, and the button waits", async () => {
  const blocked = await page(
    "mysql",
    impact({ blocker: { reason: "backupRunning", message: "A backup of db is running. Move it once the backup ends." } }),
  );
  expect(blocked).toContain("A backup of db is running. Move it once the backup ends.");
  expect(blocked).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${t("serviceAdvanced.move.button")}</button>`));
});

test("an app keeps its full tab, with Save on the next deploy", async () => {
  const out = await page("app", impact({ volumes: [] }));
  expect(out).toContain(t("serviceAdvanced.health.title"));
  expect(out).toContain(t("serviceAdvanced.container.title"));
  expect(out).toContain(t("serviceAdvanced.move.description"));
  expect(out).toContain(t("serviceAdvanced.nextDeploy"));
  expect(out).not.toContain(t("serviceAdvanced.resources.saveAndRestart"));
});

test("a database's move in progress stays on the card with its log, with both nodes placed until it ends", async () => {
  // The move job adds the new node's placement before it stops and copies.
  const placements = [
    { nodeId: "nodea00000000001", nodeName: "de-fsn-1", replicas: 1 },
    { nodeId: "nodeb00000000002", nodeName: "us-ash-1", replicas: 1 },
  ];
  const moving = { id: "depmove000000001", serviceId: "svcdb0000000003a", status: "deploying", trigger: "move" };
  const out = await page("postgres", impact(), { placements } as Partial<ServiceDetail>, [moving]);
  expect(out).toContain(`id="move"`);
  expect(out).toContain(t("serviceAdvanced.move.inProgress", { name: "db" }));
  expect(out).toContain(t("databaseVersion.viewLog"));
  // Nothing to pick while it moves.
  expect(out).not.toContain(`aria-label="${t("serviceAdvanced.move.to")}"`);
  expect(out).not.toContain(t("serviceAdvanced.move.cannotGo"));
  // Two placements and no move: not a one-node service, no card.
  const spread = await page("postgres", impact(), { placements } as Partial<ServiceDetail>);
  expect(spread).not.toContain(`id="move"`);
});
