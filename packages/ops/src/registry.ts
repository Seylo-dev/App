// Turns the generated module map (src/ops/index.gen.ts) into the flat list
// of contracts the generators and the panel work with.

import { slug } from "@seylo/brand";
import { type AnyOpContract, isOpContract, moduleOf } from "./define";

export type OpModuleMap = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * Collects every exported contract, sorted by id. Throws when an id is
 * used twice or does not start with the name of the file that defines it,
 * which keeps "where is projects.create?" answerable without a search.
 */
export function collectOps(modules: OpModuleMap): AnyOpContract[] {
  const byId = new Map<string, AnyOpContract>();
  for (const [moduleName, exports] of Object.entries(modules)) {
    for (const value of Object.values(exports)) {
      if (!isOpContract(value)) continue;
      if (moduleOf(value) !== moduleName) {
        throw new Error(`op ${value.id} is defined in src/ops/${moduleName}.ts; its id must start with "${moduleName}."`);
      }
      if (byId.has(value.id)) {
        throw new Error(`op id ${value.id} is defined twice`);
      }
      byId.set(value.id, value);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The HTTP route of an op: queries are GETs, everything else POSTs. */
export function opRoute(op: Pick<AnyOpContract, "id" | "kind">): { method: "GET" | "POST"; path: string } {
  return { method: op.kind === "query" ? "GET" : "POST", path: `${apiPrefix}/${op.id}` };
}

export const apiPrefix = "/api/v1";

/** Cookie holding the browser session token (HttpOnly; set by auth.login). */
export const sessionCookie = `${slug}_session`;
