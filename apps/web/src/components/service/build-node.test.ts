import { describe, expect, test } from "bun:test";
import { buildLoadNote, buildNodeText, cantBuildNote } from "./build-node";

type Node = {
  id: string;
  name: string;
  canBuild: boolean;
  online: boolean;
  hasBuildx: boolean;
  queued: number;
  running: number;
  waiting: number;
  buildsAtOnce: number;
};

const node = (name: string, over: Partial<Node> = {}): Node => ({
  id: `node-${name}`.padEnd(16, "0"),
  name,
  canBuild: true,
  online: true,
  hasBuildx: true,
  queued: 0,
  running: 0,
  waiting: 0,
  buildsAtOnce: 1,
  ...over,
});

const settings = (nodes: Node[], buildNodeId: string | null = null) =>
  ({ settings: { buildNodeId }, nodes }) as unknown as Parameters<typeof buildNodeText>[0];

const git = (...nodeIds: string[]) => ({ source: { type: "github" }, placements: nodeIds.map((nodeId) => ({ nodeId })) });

describe("buildNodeText", () => {
  test("the service's own node builds when it can", () => {
    const own = node("b");
    expect(buildNodeText(settings([node("a"), own]), git(own.id))).toBe("Builds on: b");
  });

  test("an own node without docker buildx is skipped, as pickBuildNode does", () => {
    const own = node("b", { hasBuildx: false });
    expect(buildNodeText(settings([node("a"), own]), git(own.id))).toBe("Builds on: a (b has no docker buildx)");
  });

  test("an offline own node is skipped too", () => {
    const own = node("b", { online: false });
    expect(buildNodeText(settings([node("a"), own]), git(own.id))).toBe("Builds on: a (b is offline)");
  });

  test("Can build off on the own node keeps its wording", () => {
    const own = node("b", { canBuild: false });
    expect(buildNodeText(settings([node("a"), own]), git(own.id))).toBe("Builds on: a (b can't build)");
  });

  test("the automatic pick is the least busy usable node, never one without buildx", () => {
    const own = node("own", { canBuild: false });
    const nodes = [node("a", { queued: 2 }), node("b", { queued: 0, hasBuildx: false }), node("c", { queued: 1 }), own];
    expect(buildNodeText(settings(nodes), git(own.id))).toBe("Builds on: c (own can't build)");
  });

  test("the automatic pick has the most free build slots, not the fewest builds, as pickBuildNode", () => {
    const own = node("own", { canBuild: false });
    // a runs 8 at once with 3 builds (5 free), b runs 1 with 1 (none free).
    const nodes = [node("a", { buildsAtOnce: 8, queued: 3 }), node("b", { buildsAtOnce: 1, queued: 1 }), own];
    expect(buildNodeText(settings(nodes), git(own.id))).toBe("Builds on: a (own can't build)");
    // The same free slots: fewer builds in flight; then by name.
    const even = [node("a", { buildsAtOnce: 4, queued: 3 }), node("b", { buildsAtOnce: 2, queued: 1 }), own];
    expect(buildNodeText(settings(even), git(own.id))).toBe("Builds on: b (own can't build)");
    const tied = [node("b", { buildsAtOnce: 2, queued: 1 }), node("a", { buildsAtOnce: 2, queued: 1 }), own];
    expect(buildNodeText(settings(tied), git(own.id))).toBe("Builds on: a (own can't build)");
  });

  test("with only builders that lack buildx no node can build", () => {
    const own = node("b", { hasBuildx: false });
    expect(buildNodeText(settings([own]), git(own.id))).toBe("No node can build right now");
  });

  test("a later placement that can build is the service's own node", () => {
    const first = node("a", { hasBuildx: false });
    const second = node("b");
    expect(buildNodeText(settings([first, second, node("c")]), git(first.id, second.id))).toBe("Builds on: b");
  });

  test("a build node from the build settings without buildx says the deploy stops there", () => {
    const chosen = node("a", { hasBuildx: false });
    expect(buildNodeText(settings([chosen, node("b")], chosen.id), git())).toBe("Build node a has no docker buildx");
    const fine = node("c");
    expect(buildNodeText(settings([chosen, fine], fine.id), git(chosen.id))).toBe("Builds on: c");
  });

  test("image services are not built", () => {
    expect(buildNodeText(settings([node("a")]), { source: { type: "image" }, placements: [] })).toBeNull();
  });
});

test("the picker's note: Can build first, then online, then buildx", () => {
  expect(cantBuildNote(node("a", { canBuild: false, online: false, hasBuildx: false }))).toBe("can't build");
  expect(cantBuildNote(node("a", { online: false, hasBuildx: false }))).toBe("offline");
  expect(cantBuildNote(node("a", { hasBuildx: false }))).toBe("no docker buildx");
  expect(cantBuildNote(node("a"))).toBeNull();
});

test("the picker's load note says how many builds run and how many wait for a slot", () => {
  expect(buildLoadNote(node("a"))).toBeNull();
  expect(buildLoadNote(node("a", { queued: 2, running: 2 }))).toBe("2 running");
  expect(buildLoadNote(node("a", { queued: 3, running: 1, waiting: 2 }))).toBe("1 running, 2 waiting");
  // A panel answer without the split (fixtures from before 0.2.15) keeps the old words.
  expect(buildLoadNote({ queued: 3 })).toBe("3 builds queued");
});
