// Contributors let the module that owns a table shape its part of the
// desired state without the compiler reading that module's tables in its
// own way. A module registers one in its start():
//
//   deps.agents.desired.contribute({
//     name: "domains",
//     service(ctx) { ctx.spec.routing = ...; },     // after the compiler's own mapping
//     node(ctx) { ctx.settings.maintenance = ...; },
//   });
//
// Contributors run by `order`, then registration order, after the built-in mapping, so
// they may replace any field. They must be pure reads (no writes, no
// agent calls) and must not throw; a throwing contributor fails that
// node's compile, which is retried on the next mark.

import type { NodeSettings, ServiceSpec } from "@seylo/proto";
import type { PanelDb } from "../db/client";
import type { services } from "../db/schema";
import type { SecretBox } from "../security/secret-box";

/**
 * Values shared by every service of one compile, built on first use: one
 * compile reads the database at one moment, so what is the same for many
 * services (a project's env graph) is built once instead of per service.
 */
export interface CompileMemo {
  get<T>(key: string, build: () => T): T;
}

export function compileMemo(): CompileMemo {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string, build: () => T): T {
      if (values.has(key)) return values.get(key) as T;
      const value = build();
      values.set(key, value);
      return value;
    },
  };
}

export interface ServiceContribution {
  db: PanelDb;
  secrets: SecretBox;
  nodeId: string;
  service: typeof services.$inferSelect;
  /** The spec as compiled so far; change it in place. */
  spec: ServiceSpec;
  /** Shared by the services of this compile (compileMemo). */
  memo: CompileMemo;
}

export interface NodeContribution {
  db: PanelDb;
  secrets: SecretBox;
  nodeId: string;
  settings: NodeSettings;
}

export interface DesiredContributor {
  /** For logs, for example "domains". */
  name: string;
  /**
   * Higher runs later (default 0); equal orders keep registration order. The
   * panel's own service uses a high order so its fixed env and ports win.
   */
  order?: number;
  service?(ctx: ServiceContribution): void;
  node?(ctx: NodeContribution): void;
}
