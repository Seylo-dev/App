// The long-lived services every op, job and endpoint can use. Built once
// in panel.ts (and by test/helpers.ts for tests); nothing reads globals.

import type { AgentHub } from "./agent-hub/hub";
import type { Config } from "./config";
import type { Databases, MetricsDb, PanelDb } from "./db/client";
import type { HealthProof } from "./http/health-proof";
import type { ProxyTrust } from "./http/proxy-trust";
import type { JobControl, JobQueue } from "./jobs/queue";
import type { Schedules } from "./jobs/schedules";
import type { LiveHub } from "./live/hub";
import type { Logger } from "./logger";
import type { AlertSink } from "./modules/alerts/sink";
import type { Notifier } from "./modules/notifications/email";
import type { ExecuteOp } from "./ops/pipeline";
import type { SecretBox } from "./security/secret-box";

/** The op pipeline, for code that runs ops on someone's behalf (MCP, AI assistant, approvals). */
export interface OpRunner {
  execute: ExecuteOp;
}

export interface Deps {
  config: Config;
  db: PanelDb;
  metrics: MetricsDb;
  secrets: SecretBox;
  logger: Logger;
  live: LiveHub;
  jobs: JobQueue;
  /** Recurring schedules on the job queue (jobs/schedules.ts). */
  schedules: Schedules;
  /**
   * Holds and releases the job runner (moving the panel, modules/panelMove).
   * Set by panel.ts; absent in deps built by hand. added in 0.2.8
   */
  jobControl?: JobControl;
  /** Consistent copies of panel.db and metrics.db (db/client.ts snapshotTo); set by panel.ts. added in 0.2.8 */
  databases?: Pick<Databases, "snapshotTo">;
  agents: AgentHub;
  /** Records alerts and notifies channels (modules/alerts/sink.ts). */
  alerts: AlertSink;
  /** Plain emails through the panel's SMTP channel (modules/notifications/email.ts). */
  notify: Notifier;
  /** Set once the op handlers are collected; calls before that fail. */
  ops: OpRunner;
  panelId: string;
  startedAt: Date;
  /** Which socket peers' X-Forwarded-* headers are believed (http/proxy-trust.ts). */
  proxy: ProxyTrust;
  /** The agents' TLS listener (security/agent-tls.ts), or null when it is off. */
  agentTls: { port: number; pin: string } | null;
  /** Proves /api/health answers come from this panel (http/health-proof.ts). */
  healthProof: HealthProof;
  /**
   * The listener these deps serve: "tailnet" for the copy panel.ts gives
   * the unix socket Tailscale Serve proxies to (http/tailnet-host.ts),
   * absent or "main" everywhere else. added in 0.2.1
   */
  listener?: "main" | "tailnet";
}
