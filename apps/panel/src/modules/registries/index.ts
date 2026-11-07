// Logins for private Docker registries used by image sources. Passwords are
// sealed and only opened when a desired state with the image is compiled.

import { OpError, registries as registryOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { eq, sql } from "drizzle-orm";
import { sourcePickerActions } from "../../auth/access";
import { userOf } from "../../auth/principal";
import type { PanelDb } from "../../db/client";
import { registryCredentials, services } from "../../db/schema";
import { implement } from "../../ops/implement";
import type { SecretBox } from "../../security/secret-box";
import { defineModule } from "../module";
import { checkRegistryLogin, type RegistryLogin } from "./login";

type Row = typeof registryCredentials.$inferSelect;
type Registry = Static<typeof registryOps.Registry>;

function usage(db: PanelDb): Map<string, number> {
  const id = sql<string | null>`json_extract(${services.spec}, '$.source.registryId')`;
  const out = new Map<string, number>();
  for (const r of db.select({ id }).from(services).where(sql`${id} is not null`).all()) if (r.id) out.set(r.id, (out.get(r.id) ?? 0) + 1);
  return out;
}

function toRegistry(row: Row, usedBy: number): Registry {
  return {
    id: row.id,
    name: row.name,
    server: row.server,
    username: row.username,
    usedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function load(db: PanelDb, registryId: string): Row {
  const row = db.select().from(registryCredentials).where(eq(registryCredentials.id, registryId)).get();
  if (!row) throw new OpError("NOT_FOUND", "No registry login with this id.", { field: "registryId" });
  return row;
}

/** The opened login of a registry row, for ImageRef.auth. */
export function openRegistryLogin(db: PanelDb, secrets: SecretBox, registryId: string): RegistryLogin | null {
  const row = db.select().from(registryCredentials).where(eq(registryCredentials.id, registryId)).get();
  if (!row) return null;
  const password = secrets.open(row.passwordSealed, "registry.credential");
  return password === null ? null : { server: row.server, username: row.username, password };
}

// People who may set an image source somewhere see names and servers for the
// picker; user names stay with people who manage registries (null for
// everyone else). An account with no such grant gets an empty list.
const list = implement(registryOps.list, (_input, ctx) => {
  const used = usage(ctx.db);
  const full = ctx.access.can("registries.manage");
  if (!full && !ctx.access.canSomewhere(sourcePickerActions)) return { registries: [] };
  return {
    registries: ctx.db
      .select()
      .from(registryCredentials)
      .orderBy(registryCredentials.name)
      .all()
      .map((r) => ({ ...toRegistry(r, used.get(r.id) ?? 0), ...(full ? {} : { username: null }) })),
  };
});

const create = implement(registryOps.create, async (input, ctx) => {
  const login = { server: input.server.toLowerCase(), username: input.username.trim(), password: input.password };
  const failure = await checkRegistryLogin(login);
  if (failure) throw new OpError("BAD_REQUEST", failure, { field: "password" });
  const row = ctx.db
    .insert(registryCredentials)
    .values({
      name: input.name.trim(),
      server: login.server,
      username: login.username,
      passwordSealed: ctx.secrets.seal(login.password, "registry.credential"),
      createdBy: userOf(ctx.principal)?.id ?? null,
    })
    .returning()
    .get();
  return toRegistry(row, 0);
});

const update = implement(registryOps.update, async (input, ctx) => {
  const row = load(ctx.db, input.registryId);
  const changes: Partial<typeof registryCredentials.$inferInsert> = {};
  if (input.name !== undefined) changes.name = input.name.trim();
  if (input.server !== undefined) changes.server = input.server.toLowerCase();
  if (input.username !== undefined) changes.username = input.username.trim();
  if (input.password !== undefined) changes.passwordSealed = ctx.secrets.seal(input.password, "registry.credential");
  if (input.server !== undefined || input.username !== undefined || input.password !== undefined) {
    const current = openRegistryLogin(ctx.db, ctx.secrets, row.id);
    const password = input.password ?? current?.password;
    if (password === undefined) throw new OpError("BAD_REQUEST", "Enter the password again.", { field: "password" });
    const failure = await checkRegistryLogin({
      server: changes.server ?? row.server,
      username: changes.username ?? row.username,
      password,
    });
    if (failure) throw new OpError("BAD_REQUEST", failure, { field: "password" });
  }
  const updated =
    Object.keys(changes).length === 0
      ? row
      : ctx.db.update(registryCredentials).set(changes).where(eq(registryCredentials.id, row.id)).returning().get();
  return toRegistry(updated, usage(ctx.db).get(row.id) ?? 0);
});

const remove = implement(registryOps.remove, (input, ctx) => {
  const row = load(ctx.db, input.registryId);
  const used = usage(ctx.db).get(row.id) ?? 0;
  if (used > 0) throw new OpError("CONFLICT", `${used} service(s) still pull with "${row.name}". Change their source first.`);
  ctx.db.delete(registryCredentials).where(eq(registryCredentials.id, row.id)).run();
  return {};
});

const test = implement(registryOps.test, async (input, ctx) => {
  load(ctx.db, input.registryId);
  const login = openRegistryLogin(ctx.db, ctx.secrets, input.registryId);
  if (!login) return { ok: false, error: "The stored password cannot be opened. Enter it again." };
  const failure = await checkRegistryLogin(login);
  return { ok: failure === null, error: failure };
});

export default defineModule({ name: "registries", ops: [list, create, update, remove, test] });
