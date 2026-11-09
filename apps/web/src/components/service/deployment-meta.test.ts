import { expect, test } from "bun:test";
import type { Deployment } from "./deploy-steps";
import { deploymentTitle, isPanelImage } from "./deployment-meta";

const base: Deployment = {
  id: "d000000000000001",
  serviceId: "svc-api",
  generation: 1,
  status: "failed",
  live: false,
  trigger: "manual",
  actor: "you@example.com",
  commit: null,
  builder: "railpack",
  builtOn: { id: "n1", name: "de-fsn-1" },
  shippedTo: [],
  image: { reference: "127.0.0.1:5755/sqotz5yg2zs1u5nn:1", digest: null, sizeBytes: null, shippedBytes: null },
  steps: [],
  durationMs: 4000,
  canRollback: false,
  rollbackOf: null,
  error: "fetching the source failed: could not fetch main - check the address, the branch and the credentials (exit status 128)",
  createdAt: "2026-11-09T10:00:00Z",
  startedAt: "2026-11-09T10:00:00Z",
  finishedAt: "2026-11-09T10:00:04Z",
};

const source = { label: "github.com/acme/private-api", branch: "main" };

test("a build that failed before it had a commit never shows the panel's internal image address", () => {
  expect(deploymentTitle(base, source)).toBe("Deploy from main");
  expect(deploymentTitle(base, source)).not.toContain("127.0.0.1");
  // No branch known: the source line. Nothing known: the generation, still not the address.
  expect(deploymentTitle(base, { label: "Inline Dockerfile", branch: null })).toBe("Deploy from Inline Dockerfile");
  expect(deploymentTitle(base)).toBe("Generation 1");
  // Even without a builder on record, a loopback registry address is the panel's own.
  expect(deploymentTitle({ ...base, builder: null }, source)).toBe("Deploy from main");
});

test("the commit wins when known, then rollbacks, moves and pulled images", () => {
  const commit = { sha: "3b8d2aa00", message: "Queue retries with backoff\n\nLonger body", branch: "main", author: null };
  expect(deploymentTitle({ ...base, commit }, source)).toBe("Queue retries with backoff");
  // A commit the panel found by ls-remote has no message: its branch, and the sha shows next to the title.
  expect(deploymentTitle({ ...base, commit: { ...commit, message: "", branch: "release" } }, source)).toBe("Deploy from release");
  expect(deploymentTitle({ ...base, trigger: "rollback" }, source)).toBe("Rollback");
  expect(deploymentTitle({ ...base, trigger: "move" }, source)).toBe("Move to another node");
  const pulled = { ...base, builder: null, builtOn: null, image: { ...base.image, reference: "ghcr.io/acme/api:1.4" } } as Deployment;
  expect(deploymentTitle(pulled, { label: "ghcr.io/acme/api:1.4", branch: null })).toBe("Deploy ghcr.io/acme/api:1.4");
  expect(deploymentTitle({ ...pulled, image: { ...base.image, reference: "nginx:1.27" } } as Deployment)).toBe("Deploy nginx:1.27");
});

test("panel registry addresses are told apart from registry images", () => {
  expect(isPanelImage("127.0.0.1:5755/sqotz5yg2zs1u5nn:1")).toBe(true);
  expect(isPanelImage("localhost:5755/api:3")).toBe(true);
  expect(isPanelImage("[::1]:5755/api:3")).toBe(true);
  expect(isPanelImage("nginx:1.27")).toBe(false);
  expect(isPanelImage("ghcr.io/acme/api:1.4")).toBe(false);
  expect(isPanelImage("registry.local:5000/worker")).toBe(false);
});
