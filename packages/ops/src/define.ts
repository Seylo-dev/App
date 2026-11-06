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
  /** Written to the audit log. Every mutation and destructive op must audit. */
  readonly audit: boolean;
  readonly rateLimit?: RateLimitClass;
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

export function defineOp<Kind extends OpKind, Input extends TObject, Output extends TSchema>(
  definition: OpDefinition<Kind, Input, Output>,
): OpContract<Kind, Input, Output> {
  if (!opIdPattern.test(definition.id)) {
    throw new Error(`op id "${definition.id}" must look like "module.action" in lower camel case`);
  }
  if (definition.kind !== "query" && !definition.audit) {
    throw new Error(`op ${definition.id}: ${definition.kind} ops must set audit: true`);
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
