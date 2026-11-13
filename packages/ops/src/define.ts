// defineOp declares an operation's contract: everything about it except the
// code that runs it. Contracts live in this package so the web app, the
// generators and the panel share one definition; the panel attaches the
// implementation in apps/panel/src/modules/<module>/.

import type { Static, TObject, TSchema } from "@sinclair/typebox";
import type { AnyPermission, Permission } from "./permission";

/**
 * query: reads only; GET route, safe to retry, never needs approval.
 * mutation: changes state; POST route.
 * destructive: deletes or overwrites data that cannot be recovered; POST
 * route, and model callers (MCP, AI) always need a person's approval.
 */
export type OpKind = "query" | "mutation" | "destructive";

/**
 * Rate limit class applied per principal. "strict" is for ops an attacker
 * would brute force (sign-in, token checks).
 */
export type RateLimitClass = "standard" | "strict";

/**
 * Dotted paths to fields that must never be stored or shown in clear text
 * (audit log, approvals, MCP and AI transcripts). `*` matches any array
 * index or record key: "env.*.value".
 */
export interface SensitiveFields {
  readonly input?: readonly string[];
  readonly output?: readonly string[];
}

export interface OpDefinition<Kind extends OpKind, Input extends TObject, Output extends TSchema> {
  /**
   * "<module>.<action>" in lower camel case, for example "projects.create".
   * It is the route path, the MCP tool name and the audit key, so it never
   * changes once released. <module> is the file in src/ops/ that defines it.
   */
  readonly id: string;
  readonly kind: Kind;
  /** One line in the imperative, for example "Create a project". */
  readonly summary: string;
  /** What it does and when to use it; models read this to pick a tool. */
  readonly description: string;
  /** Always an object so it maps to query params, a JSON body and MCP input. */
  readonly input: Input;
  readonly output: Output;
  readonly permission: Permission<Static<Input>>;
  readonly sensitive?: SensitiveFields;
  /** Exposed to models: the MCP server and the AI assistant. */
  readonly mcp: boolean;
  /**
   * A mutation that model callers (MCP, AI) may only run once a person
   * approved it, like a destructive op, though it deletes nothing. true:
   * every call, as it hands data out of the panel (backups.downloadUrl).
   * "conditional": only the calls its panel handler's modelApproval check
   * picks from the input and the resource as it is now, for an op where
   * some inputs weaken a protection (databases.setExposure letting clients
   * in without TLS) and the rest are ordinary changes. MCP tokens skip it
   * while "Ask before destructive actions" is off, as they skip destructive
   * ones.
   */
  readonly modelApproval?: true | "conditional";
  /** Written to the audit log. Every mutation and destructive op must audit. */
  readonly audit: boolean;
  readonly rateLimit?: RateLimitClass;
  /**
   * Largest JSON body the HTTP route reads, in bytes. Bodies are read before
   * authentication, so most ops keep the default (1 MiB, `defaultOpBodyBytes`
   * in ./server/elysia.ts); only ops whose input really is large (file
   * contents, compose files, maintenance pages) raise it, up to 4 MiB.
   */
  readonly maxBodyBytes?: number;
}

const contractBrand: unique symbol = Symbol("seylo.op");

export type OpContract<Kind extends OpKind = OpKind, Input extends TObject = TObject, Output extends TSchema = TSchema> = OpDefinition<
  Kind,
  Input,
  Output
> & { readonly [contractBrand]: true };

/** Any contract, whatever its kind and schemas. */
export type AnyOpContract = Omit<OpContract, "permission"> & { readonly permission: AnyPermission };

export type OpInput<C extends AnyOpContract> = Static<C["input"]>;
export type OpOutput<C extends AnyOpContract> = Static<C["output"]>;

export const opIdPattern = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;

/** The JSON body an op's HTTP route reads when the contract says nothing (OpDefinition.maxBodyBytes). */
export const defaultOpBodyBytes = 1024 * 1024;
/** The most any op may raise it to. */
export const maxOpBodyBytes = 4 * 1024 * 1024;

export function defineOp<Kind extends OpKind, Input extends TObject, Output extends TSchema>(
  definition: OpDefinition<Kind, Input, Output>,
): OpContract<Kind, Input, Output> {
  if (!opIdPattern.test(definition.id)) {
    throw new Error(`op id "${definition.id}" must look like "module.action" in lower camel case`);
  }
  if (definition.kind !== "query" && !definition.audit) {
    throw new Error(`op ${definition.id}: ${definition.kind} ops must set audit: true`);
  }
  if (definition.maxBodyBytes !== undefined && !(definition.maxBodyBytes > 0 && definition.maxBodyBytes <= maxOpBodyBytes)) {
    throw new Error(`op ${definition.id}: maxBodyBytes must be between 1 and ${maxOpBodyBytes}`);
  }
  return Object.freeze({ ...definition, [contractBrand]: true as const });
}

/** Generic so `Object.values(module).filter(isOpContract)` narrows to the module's contracts. */
export function isOpContract<T>(value: T): value is T & AnyOpContract {
  return typeof value === "object" && value !== null && contractBrand in value;
}

/** "projects" for "projects.create". */
export function moduleOf(op: Pick<AnyOpContract, "id">): string {
  return op.id.slice(0, op.id.indexOf("."));
}
