// Logins for private Docker registries, used by image sources. Passwords
// are stored sealed and never returned.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

const RegistryName = Type.String({ minLength: 1, maxLength: 60 });
const Server = Type.String({
  minLength: 1,
  maxLength: 253,
  pattern: "^[A-Za-z0-9.-]+(:[0-9]{1,5})?$",
  description: 'Registry host, for example "ghcr.io" or "registry.example.com:5000". Docker Hub is "docker.io".',
});
const Username = Type.String({ minLength: 1, maxLength: 200 });
const Password = Type.String({ minLength: 1, maxLength: 5000, description: "Password or access token." });

export const Registry = Type.Object({
  id: Id,
  name: RegistryName,
  server: Server,
  /** Null for people without registries.manage: they pick logins by name only. */
  username: Type.Union([Username, Type.Null()]),
  /** Services whose image source uses it. */
  usedBy: Type.Integer({ minimum: 0 }),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const list = defineOp({
  id: "registries.list",
  kind: "query",
  summary: "List registry logins",
  description:
    "Lists stored registry logins by name and server (never the password), so people can pick one for an image source. The user name is null unless the caller manages registries. Empty for callers who may create or edit services nowhere.",
  input: Type.Object({}),
  output: Type.Object({ registries: Type.Array(Registry) }),
  // Names only, for people who may set a source somewhere (services.create or services.update).
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const create = defineOp({
  id: "registries.create",
  kind: "mutation",
  summary: "Add a registry login",
  description:
    "Stores a login for a private Docker registry, sealed. The panel checks it with a registry login first and refuses ones that fail.",
  input: Type.Object({ name: RegistryName, server: Server, username: Username, password: Password }),
  output: Registry,
  permission: permission.global("registries.manage"),
  sensitive: { input: ["password"] },
  mcp: false,
  audit: true,
});

export const update = defineOp({
  id: "registries.update",
  kind: "mutation",
  summary: "Change a registry login",
  description:
    "Renames a registry login or replaces its server, user name or password. Omitted fields keep their value. Changes apply on the next deploy that pulls.",
  input: Type.Object({
    registryId: Id,
    name: Type.Optional(RegistryName),
    server: Type.Optional(Server),
    username: Type.Optional(Username),
    password: Type.Optional(Password),
  }),
  output: Registry,
  permission: permission.global("registries.manage"),
  sensitive: { input: ["password"] },
  mcp: false,
  audit: true,
});

export const remove = defineOp({
  id: "registries.delete",
  kind: "destructive",
  summary: "Delete a registry login",
  description: "Deletes a registry login. Fails while a service's image source still uses it.",
  input: Type.Object({ registryId: Id }),
  output: Empty,
  permission: permission.global("registries.manage"),
  mcp: true,
  audit: true,
});

export const test = defineOp({
  id: "registries.test",
  kind: "query",
  summary: "Check a registry login",
  description: "Logs in to the registry with a stored login and says whether it worked, with the registry's error when it did not.",
  input: Type.Object({ registryId: Id }),
  output: Type.Object({ ok: Type.Boolean(), error: Type.Union([Type.String(), Type.Null()]) }),
  permission: permission.global("registries.manage"),
  mcp: true,
  audit: false,
});
