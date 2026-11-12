import { expect, test } from "bun:test";
import { databases } from "@seylo/ops";
import { t } from "../../../i18n/t";
import { renderStatic } from "../../../test/render";
import type { ServiceDetail } from "../use-service";
import { UsersPage } from "./users-page";

const service = { id: "svc-db", projectId: "prj-1", name: "db", kind: "postgres", placements: [] } as unknown as ServiceDetail;

const can = (password: boolean, rename: boolean, del: boolean, makeMain: boolean) => ({
  passwordChange: password,
  rename,
  delete: del,
  makeMain,
});
const user = (over: Record<string, unknown>) => ({
  host: null,
  authDatabase: null,
  main: false,
  system: false,
  access: "readWrite",
  roles: [],
  locked: false,
  ownsObjects: 0,
  definerObjects: null,
  passwordForRename: false,
  can: can(true, true, true, true),
  why: null,
  ...over,
});

const postgres = {
  engine: "postgres",
  users: [
    user({ name: "postgres", main: true, access: "serverAdmin", can: can(true, true, false, false), why: "Seylo signs in with this one." }),
    user({ name: "app", ownsObjects: 3 }),
    user({ name: "reports", access: "readOnly", locked: true }),
    user({
      name: "odd\\name",
      access: "custom",
      roles: ["pg_monitor"],
      can: can(false, false, false, false),
      why: "Manage this one from the shell.",
    }),
  ],
  truncated: false,
  presets: ["readOnly", "readWrite", "serverAdmin"],
  hosts: false,
  canCreate: true,
  notice: null,
  main: { user: "postgres", rename: "inPlace", canSwitch: true },
  signIn: "ok",
  message: null,
};

const render = (answer: object) =>
  renderStatic(() => <UsersPage service={service} />, [[databases.users, { serviceId: "svc-db" }, answer]]);

/** The markup of one user's row, by the name it starts with. */
function row(out: string, name: string): string {
  const at = out.indexOf(`>${name}<`);
  if (at < 0) return "";
  return out.slice(out.lastIndexOf("<li", at), out.indexOf("</li>", at));
}

test("the main user first, with its Change buttons; the others' access, ownership and menus", async () => {
  const out = await render(postgres);
  expect(out).toContain(t("serviceDatabaseUsers.count", { count: 4 }));
  expect(out.indexOf(">postgres<")).toBeLessThan(out.indexOf(">app<"));
  const main = row(out, "postgres");
  expect(main).toContain(t("serviceDatabaseUsers.main"));
  expect(main).toContain(t("serviceDatabaseUsers.mainLine"));
  expect(main).toContain(t("serviceDatabaseUsers.changePassword"));
  expect(main).toContain(t("serviceDatabaseUsers.changeName"));
  expect(main).toContain(t("serviceDatabaseUsers.access.serverAdmin"));
  // No menu for the main user: it is never deleted here.
  expect(main).not.toContain(t("serviceDatabaseUsers.more", { name: "postgres" }));
  const app = row(out, "app");
  expect(app).toContain(t("serviceDatabaseUsers.access.readWrite"));
  expect(app).toContain(t("serviceDatabaseUsers.owns", { count: 3 }));
  expect(app).toContain(`aria-label="${t("serviceDatabaseUsers.more", { name: "app" })}"`);
  expect(row(out, "reports")).toContain(t("serviceDatabaseUsers.locked"));
  // A user nothing may be done with: no menu, and why.
  const odd = row(out, "odd\\name");
  expect(odd).not.toContain("aria-haspopup");
  expect(odd).toContain("Manage this one from the shell.");
  expect(odd).toContain("pg_monitor");
  expect(out).toContain(t("serviceDatabaseUsers.newUser"));
  expect(out).toContain(t("serviceDatabaseUsers.switchMain"));
});

test("MySQL hosts and the root rows, MongoDB auth databases", async () => {
  const mysql = await render({
    ...postgres,
    engine: "mysql",
    hosts: true,
    main: { user: "root", rename: "switch", canSwitch: true },
    users: [
      user({ name: "root", host: "%", main: true, access: "serverAdmin", can: can(true, true, false, false) }),
      user({
        name: "root",
        host: "localhost",
        system: true,
        access: "serverAdmin",
        can: can(false, false, false, false),
        why: "Used inside the container.",
      }),
      user({ name: "app", host: "10.0.%", definerObjects: 2 }),
    ],
  });
  expect(mysql).toContain(">@localhost</span>");
  expect(mysql).toContain(">@10.0.%</span>");
  expect(row(mysql, "app")).toContain(t("serviceDatabaseUsers.definers", { count: 2 }));
  expect(mysql).toContain(t("serviceDatabaseUsers.system"));
  const mongo = await render({
    ...postgres,
    engine: "mongo",
    main: { user: "root", rename: "switch", canSwitch: true },
    users: [
      user({ name: "root", authDatabase: "admin", main: true, access: "serverAdmin" }),
      user({ name: "legacy", authDatabase: "shop" }),
    ],
  });
  expect(mongo).toContain(t("serviceDatabaseUsers.authDatabase", { database: "shop" }));
  expect(mongo).not.toContain(t("serviceDatabaseUsers.authDatabase", { database: "admin" }));
});

test("Redis: one user, its password only, and why; offline and failed sign-in say what to do", async () => {
  const redis = await render({
    ...postgres,
    engine: "redis",
    presets: [],
    canCreate: false,
    notice: "Redis has one user, default, and only its password changes here.",
    main: { user: "default", rename: "none", canSwitch: false },
    users: [user({ name: "default", main: true, access: "serverAdmin", can: can(true, false, false, false) })],
  });
  expect(redis).toContain("Redis has one user, default");
  expect(redis).toContain(t("serviceDatabaseUsers.changePassword"));
  expect(redis).not.toContain(t("serviceDatabaseUsers.changeName"));
  expect(redis).not.toContain(t("serviceDatabaseUsers.newUser"));
  expect(redis).not.toContain(t("serviceDatabaseUsers.switchMain"));

  const offline = await render({
    ...postgres,
    signIn: "offline",
    message: "The database is stopped. Start it to see and change its users.",
    users: [user({ name: "postgres", main: true, can: can(false, false, false, false) })],
  });
  expect(offline).toContain("The database is stopped.");
  expect(offline).not.toContain(t("serviceDatabaseUsers.newUser"));
  expect(offline).not.toContain(t("serviceDatabaseUsers.changePassword"));

  const failed = await render({ ...postgres, engine: "mongo", signIn: "failed", message: "MongoDB refused Seylo's sign-in." });
  expect(failed).toContain("MongoDB refused Seylo&#x27;s sign-in.");
  expect(failed).toContain(t("serviceDatabaseUsers.enterWorking"));
  const pgFailed = await render({ ...postgres, signIn: "failed", message: "x" });
  expect(pgFailed).toContain(t("serviceDatabaseUsers.setAgain"));
});
