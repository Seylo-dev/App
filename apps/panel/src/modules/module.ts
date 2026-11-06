// A feature module: apps/panel/src/modules/<name>/index.ts default-exports
// defineModule({...}). scripts/gen-indexes.ts lists every module in
// modules/index.gen.ts, so adding a feature never edits a shared file:
// ops, jobs, extra HTTP endpoints and startup subscriptions all hang off
// the module instead of panel.ts.

import { type AnyOpContract, isOpContract } from "@seylo/ops";
import type { AnyElysia } from "elysia";
import type { Deps } from "../deps";
import type { JobHandler } from "../jobs/queue";
import { notImplemented, type OpHandler } from "../ops/implement";

export interface PanelModule {
  /** Same as the folder name and the op id prefix. */
  name: string;
  // The handler's contract type is erased here; implement() checked it.
  ops: readonly OpHandler<AnyOpContract>[];
  jobs?: readonly JobHandler[];
  /**
   * HTTP endpoints that cannot be ops because a third party or a socket
   * defines their shape: GitHub webhooks, deploy trigger URLs, the MCP
   * endpoint and its OAuth routes, terminal and log WebSockets. Mounted
   * after the op routes and before the web app. Never put an action here
   * that a person could trigger through an op: ops are what get permission
   * checks, audit, OpenAPI and MCP for free.
   */
  http?: (deps: Deps) => AnyElysia;
  /**
   * Runs once when the panel is built, before it serves: subscribe to
   * agent events (deps.agents.onEvent) or register recurring schedules.
   * Keep it synchronous and cheap; background work belongs in jobs.
   */
  start?: (deps: Deps) => void;
}

export function defineModule(module: PanelModule): PanelModule {
  return module;
}

/**
 * notImplemented() (ops/implement.ts) for every contract exported by an op
 * module except the ones that already have handlers. `contracts` is the module namespace
 * from @seylo/ops, for example `import { cron } from "@seylo/ops"`.
 */
export function notImplementedExcept(
  contracts: Readonly<Record<string, unknown>>,
  built: readonly OpHandler<AnyOpContract>[],
): OpHandler<AnyOpContract>[] {
  const done = new Set(built.map((handler) => handler.contract.id));
  return Object.values(contracts)
    .filter(isOpContract)
    .filter((contract) => !done.has(contract.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((contract) => notImplemented(contract));
}
