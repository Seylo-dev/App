// Desired state: what each node should run, compiled from DB rows and sent
// to its agent. Modules only ever call deps.agents.desired.markDirty(...)
// (dirty.ts) and, for their own tables, deps.agents.desired.contribute(...)
// (contributors.ts). compile.ts turns rows into a DesiredState; flusher.ts
// sends it.

export { type CompileOptions, compileDesiredState, compileNodeSettings, compileServiceSpec, placedServiceIds } from "./compile";
export type { DesiredContributor, NodeContribution, ServiceContribution } from "./contributors";
export { createDesiredStateSync, type DesiredStateSync, type DesiredTarget, type RefusedSpec } from "./dirty";
export { type DesiredFlusher, startDesiredFlusher } from "./flusher";
