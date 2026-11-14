// What a template's generate() must return, checked before anything is
// shown or created. The shape follows Easypanel's template output
// (services[] of { type, data }), limited to what this panel can run.

import { domains, services } from "@seylo/ops";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const ServiceName = Type.String({ minLength: 1, maxLength: 40, pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$" });
const AbsolutePath = Type.String({ minLength: 1, maxLength: 500, pattern: "^/" });

export const TemplateDomain = Type.Object({
  /**
   * "$(PRIMARY_DOMAIN)" (or omitted, or "$(EASYPANEL_DOMAIN)") = the node's
   * automatic domain; anything else is a custom host, held to domains.add's
   * rules: installing adds it through domains.add's code, which leaves input
   * checks to the op pipeline.
   */
  host: Type.Optional(
    Type.Union([Type.Literal(""), Type.Literal("$(PRIMARY_DOMAIN)"), Type.Literal("$(EASYPANEL_DOMAIN)"), domains.Hostname]),
  ),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  path: Type.Optional(domains.PathPrefix),
});

export const TemplateMount = Type.Union([
  Type.Object({
    type: Type.Literal("volume"),
    // The agent's rule for names on disk (services.volumeNamePattern): no dots.
    name: Type.String({ minLength: 1, maxLength: 60, pattern: services.volumeNamePattern }),
    mountPath: AbsolutePath,
  }),
  Type.Object({ type: Type.Literal("file"), content: Type.String({ maxLength: 200_000 }), mountPath: AbsolutePath }),
]);

export const TemplateApp = Type.Object({
  type: Type.Literal("app"),
  data: Type.Object({
    serviceName: ServiceName,
    source: Type.Object({ type: Type.Literal("image"), image: Type.String({ minLength: 1, maxLength: 300, pattern: "^\\S+$" }) }),
    /** .env text; may use ${{service.VAR}} references. */
    env: Type.Optional(Type.String({ maxLength: 100_000 })),
    domains: Type.Optional(Type.Array(TemplateDomain, { maxItems: 10 })),
    mounts: Type.Optional(Type.Array(TemplateMount, { maxItems: 20 })),
    /** Ports the container listens on besides the domains' ports. */
    ports: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 65535 }), { maxItems: 20 })),
    deploy: Type.Optional(
      Type.Object({
        command: Type.Optional(Type.String({ maxLength: 2000 })),
        replicas: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
      }),
    ),
  }),
});

export const TemplateDatabase = Type.Object({
  type: Type.Union([
    Type.Literal("postgres"),
    Type.Literal("mysql"),
    Type.Literal("mariadb"),
    Type.Literal("mongo"),
    Type.Literal("redis"),
    Type.Literal("valkey"),
    Type.Literal("keydb"),
    Type.Literal("dragonfly"),
    Type.Literal("clickhouse"),
  ]),
  data: Type.Object({
    serviceName: ServiceName,
    /** Major version, for example "17"; default the engine's newest. */
    version: Type.Optional(Type.String({ maxLength: 20 })),
    /** Image variant, for example "pgvector" for postgres. */
    variant: Type.Optional(Type.String({ minLength: 1, maxLength: 30, pattern: "^[a-z0-9-]+$" })),
    database: Type.Optional(Type.String({ minLength: 1, maxLength: 63, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" })),
    user: Type.Optional(Type.String({ minLength: 1, maxLength: 63, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" })),
    password: Type.Optional(Type.String({ minLength: 12, maxLength: 128, pattern: "^[A-Za-z0-9._~-]+$" })),
  }),
});

export const TemplateOutput = Type.Object({
  services: Type.Array(Type.Union([TemplateApp, TemplateDatabase]), { minItems: 1, maxItems: 20 }),
});

export type TemplateOutput = Static<typeof TemplateOutput>;
export type TemplateService = TemplateOutput["services"][number];

export class TemplateError extends Error {
  override name = "TemplateError";
}

/** Throws a TemplateError naming the first problem, so template authors can fix it. */
export function checkOutput(value: unknown): TemplateOutput {
  if (!Value.Check(TemplateOutput, value)) {
    // A service is a union of the app and database shapes: name the field of the shape its type picks, not just "union".
    const services = (value as { services?: unknown })?.services;
    if (Array.isArray(services))
      for (const [i, service] of services.entries()) {
        const type = (service as { type?: unknown })?.type;
        const shape = type === "app" ? TemplateApp : typeof type === "string" && type !== "" ? TemplateDatabase : null;
        const error = shape && !Value.Check(shape, service) ? [...Value.Errors(shape, service)][0] : undefined;
        if (error) throw new TemplateError(`generate() returned an invalid result at /services/${i}${error.path}: ${error.message}`);
      }
    const first = [...Value.Errors(TemplateOutput, value)][0];
    throw new TemplateError(`generate() returned an invalid result at ${first?.path || "/"}: ${first?.message ?? "unknown"}`);
  }
  const names = value.services.map((s) => s.data.serviceName);
  const dupe = names.find((n, i) => names.indexOf(n) !== i);
  if (dupe) throw new TemplateError(`generate() returned two services named ${dupe}.`);
  return value;
}
