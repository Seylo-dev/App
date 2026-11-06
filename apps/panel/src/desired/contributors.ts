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

export interface ServiceContribution {
  db: PanelDb;
  secrets: SecretBox;
  nodeId: string;
  service: typeof services.$inferSelect;
  /** The spec as compiled so far; change it in place. */
  spec: ServiceSpec;
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
