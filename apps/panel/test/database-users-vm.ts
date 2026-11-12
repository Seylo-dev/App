// The Users tab's scripts as the VM test runs them on real images
// (go/internal/backup/database_users_it_test.go): per engine, the
// container the panel would start (image, env, command, data path) and
// every step of one scenario, built by the panel's own functions
// (user-scripts.ts, engines.ts) with fixed names, passwords and SCRAM
// salts. database-users-vm.test.ts keeps the committed JSON equal to this
// (UPDATE_VM_FIXTURES=1 writes it), so the Go test always runs what the
// panel sends. The Go test drives the scenario, proves each user's rights
// with the engine's own client and records the list outputs, which
// database-users-vm.test.ts parses with the panel's parser.

import {
  type Credentials,
  changePasswordExec,
  containerCommand,
  containerEnv,
  engines,
  healthCommand,
} from "../src/modules/databases/engines";
import {
  type Admin,
  createUserExec,
  deleteUserExec,
  type Exec,
  listExec,
  mainPasswordExec,
  mysqlAfterSwitchExec,
  proofExec,
  renameUserExec,
  setPasswordExec,
  switchPrepareExec,
} from "../src/modules/databases/user-scripts";

export type VmEngine = "postgres" | "mysql" | "mariadb" | "mongo" | "clickhouse";

export interface VmStep {
  name: string;
  command: string[];
  stdin: string;
}

export interface VmScenario {
  engine: VmEngine;
  image: string;
  dataPath: string;
  command: string[];
  health: string[];
  /** The container's env at the first start, and once the main user changed (the next deploy). */
  env: Record<string, string>;
  envAfter: Record<string, string>;
  database: string;
  /** Who is who: names and passwords the Go test signs in with. */
  values: Record<string, string>;
  steps: VmStep[];
}

const salt = Buffer.from("seylo-vm-fixture", "utf8");
const options = { salt, suffix: "fixture0" };

export const vmValues = {
  database: "app",
  initial: "MainPassword000a",
  second: "MainPassword111b",
  third: "MainPassword222c",
  newMain: "boss",
  newMainPassword: "BossPassword333d",
  reader: "reader",
  readerPassword: "ReaderPassword4e",
  readerPassword2: "ReaderPassword5f",
  writer: "writer",
  writerPassword: "WriterPassword6g",
  writer2: "writer2",
  writer2Password: "WriterPassword7h",
  dbAdmin: "dbadmin",
  dbAdminPassword: "DbAdminPassword8",
  serverAdmin: "sadmin",
  serverAdminPassword: "SAdminPassword9i",
};

const v = vmValues;

/** The image's first main user per engine in the scenario: Postgres's bootstrap role, MySQL's root, MariaDB with its own admin. */
const firstMain: Record<VmEngine, string> = {
  postgres: "postgres",
  mysql: "root",
  mariadb: "shop",
  mongo: "root",
  clickhouse: "ch_admin",
};

/** The databases of a fresh Postgres that take connections: what the list reports and a delete visits. */
const postgresDatabases = ["app", "postgres", "template1"];

const env = (engine: VmEngine, creds: Credentials) => Object.fromEntries(containerEnv(engine, creds).map((e) => [e.name, e.value]));

const step = (name: string, exec: Exec | null): VmStep => {
  if (!exec) throw new Error(`no exec for ${name}`);
  return { name, command: exec.command, stdin: exec.stdin };
};

export function vmScenario(engine: VmEngine): VmScenario {
  const e = engines[engine];
  const version = e.versions[0];
  if (!version) throw new Error(`no version of ${engine}`);
  const main0 = firstMain[engine];
  const admin = (user: string, password: string): Admin => ({ user, password, database: v.database });
  const a0 = admin(main0, v.initial);
  const steps: VmStep[] = [step("list0", listExec(engine, a0))];
  steps.push(
    step(
      "createReader",
      createUserExec(engine, a0, { name: v.reader, host: "%", access: "readOnly", password: v.readerPassword }, options),
    ),
  );
  steps.push(
    step(
      "createWriter",
      createUserExec(engine, a0, { name: v.writer, host: "%", access: "readWrite", password: v.writerPassword }, options),
    ),
  );
  if (engine !== "postgres")
    steps.push(
      step(
        "createDbAdmin",
        createUserExec(engine, a0, { name: v.dbAdmin, host: "%", access: "databaseAdmin", password: v.dbAdminPassword }, options),
      ),
    );
  steps.push(
    step(
      "createServerAdmin",
      createUserExec(engine, a0, { name: v.serverAdmin, host: "%", access: "serverAdmin", password: v.serverAdminPassword }, options),
    ),
  );
  steps.push(step("list1", listExec(engine, a0)));
  const reader = { name: v.reader, host: "%", authDatabase: "admin" };
  const writer = { name: v.writer, host: "%", authDatabase: "admin" };
  const writer2 = { name: v.writer2, host: "%", authDatabase: "admin" };
  steps.push(step("passwordReader", setPasswordExec(engine, a0, reader, v.readerPassword2, options)));
  steps.push(
    step(
      "renameWriter",
      renameUserExec(engine, a0, writer, { name: v.writer2, host: "%", password: engine === "mongo" ? v.writer2Password : null }, options),
    ),
  );
  steps.push(step("deleteReader", deleteUserExec(engine, a0, reader, { databases: postgresDatabases, killSessions: true })));
  // Postgres: writer2 owns the table it made; its delete gives it to the main user first.
  if (engine === "postgres") steps.push(step("deleteWriter2", deleteUserExec(engine, a0, writer2, { databases: postgresDatabases })));
  steps.push(step("list2", listExec(engine, a0)));

  // The main user's password twice before any deploy (the container keeps its first env).
  let after: Admin = a0;
  if (engine === "postgres" || engine === "mongo") {
    steps.push(step("mainPassword1", mainPasswordExec(engine, a0, v.second, options)));
    steps.push(step("mainPassword2", mainPasswordExec(engine, admin(main0, v.second), v.third, options)));
    after = admin(main0, v.third);
  } else if (engine === "mysql" || engine === "mariadb") {
    steps.push(step("mainPassword1", changePasswordExec(engine, main0, v.second, v.initial)));
    steps.push(step("mainPassword2", changePasswordExec(engine, main0, v.third, v.second)));
    after = admin(main0, v.third);
  }

  // The main user's name: in place (Postgres's bootstrap role, MariaDB's own admin), a switch (MySQL's root,
  // MongoDB), or the restart ClickHouse takes it with (the Go test deploys envAfter).
  const boss = admin(v.newMain, v.newMainPassword);
  let final: Admin = after;
  if (engine === "postgres") {
    steps.push(
      step(
        "mainRename",
        renameUserExec(
          engine,
          after,
          { name: main0, host: "%", authDatabase: "admin" },
          { name: v.newMain, host: "%", password: null },
          options,
        ),
      ),
    );
    final = { ...after, user: v.newMain };
  } else if (engine === "mariadb") {
    steps.push(
      step(
        "mainRename",
        renameUserExec(engine, after, { name: main0, host: "%", authDatabase: "admin" }, { name: v.newMain, host: "%", password: null }),
      ),
    );
    final = { ...after, user: v.newMain };
  } else if (engine === "mysql" || engine === "mongo") {
    steps.push(
      step(
        "switchPrepare",
        switchPrepareExec(engine, after, { name: v.newMain, password: v.newMainPassword, existing: false, grantAdmin: false }, options),
      ),
    );
    steps.push(step("switchProof", proofExec(engine, boss)));
    steps.push(step("switchProofWrong", proofExec(engine, { ...boss, password: v.initial })));
    if (engine === "mysql")
      steps.push(step("switchAfter", mysqlAfterSwitchExec(engine, after, v.newMainPassword, { name: "root", host: "%" })));
    final = boss;
  } else {
    final = boss;
  }
  steps.push(step("listAfter", listExec(engine, final)));
  steps.push(step("proofFinal", engine === "clickhouse" ? listExec(engine, final) : proofExec(engine, final)));
  return {
    engine,
    image: version.image,
    dataPath: version.dataPath,
    command: containerCommand(engine),
    health: engine === "mongo" ? [] : healthCommand(engine),
    env: env(engine, a0),
    envAfter: env(engine, final),
    database: v.database,
    values: { ...v, main: main0, finalMain: final.user, finalPassword: final.password },
    steps,
  };
}

export const vmEngines: VmEngine[] = ["postgres", "mysql", "mariadb", "mongo", "clickhouse"];

export function vmFixture(): { scenarios: VmScenario[] } {
  return { scenarios: vmEngines.map(vmScenario) };
}
