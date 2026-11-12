// "Builds at once" on Auto (nodes.updateSettings parallelBuildsAuto): how
// many builds a node runs at the same time, sized from the cores and memory
// its agent reported. One build per 4 cores and per 4 GiB of memory,
// whichever allows fewer, at least 1 and at most 16. A fixed "unlimited"
// would let one monorepo push start a BuildKit job per service on a node
// that also runs game servers; Auto grows with the machine instead.
//
// The panel sends the result to the agent (NodeSettings.max_parallel_builds,
// apps/panel/src/desired/compile.ts) and returns it as the nodes view's
// maxParallelBuilds; the web app shows it next to the setting. One function,
// so the three never disagree.

/** The most builds a node runs at once, on Auto and as a fixed number. */
export const maxParallelBuildsLimit = 16;

const coresPerBuild = 4;
const memoryPerBuild = 4 * 1024 ** 3;

/** The two NodeFacts fields Auto reads; memory as a number (the view) or a bigint (protobuf). */
export interface ParallelBuildsFacts {
  cpuCores: number;
  memoryTotalBytes: number | bigint;
}

/**
 * Builds at once on Auto: min(floor(cores / 4), floor(memory / 4 GiB)),
 * clamped to 1..16. No facts yet (a node that never connected) or facts
 * without cores or memory (an agent that does not report them) give 1.
 */
export function autoParallelBuilds(facts: ParallelBuildsFacts | null | undefined): number {
  if (!facts) return 1;
  const byCores = Math.floor(facts.cpuCores / coresPerBuild);
  const byMemory = Math.floor(Number(facts.memoryTotalBytes) / memoryPerBuild);
  const builds = Math.min(byCores, byMemory);
  if (!Number.isFinite(builds)) return 1;
  return Math.max(1, Math.min(maxParallelBuildsLimit, builds));
}
