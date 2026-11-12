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
  source: "main",
  builder: "railpack",
  builtOn: { id: "n1", name: "de-fsn-1" },
  buildWait: null,
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

const github = { type: "github", label: "acme/private-api" };

test("a build that failed before it had a commit never shows the panel's internal image address", () => {
  expect(deploymentTitle(base, github)).toBe("Deploy from main");
  expect(deploymentTitle(base, github)).not.toContain("127.0.0.1");
  // Nothing recorded: the generation, still not the address.
  expect(deploymentTitle({ ...base, source: null }, github)).toBe("Generation 1");
  expect(deploymentTitle({ ...base, source: null })).toBe("Generation 1");
  // Even without a builder on record, a loopback registry address is the panel's own.
  expect(deploymentTitle({ ...base, builder: null }, github)).toBe("Deploy from main");
});

test("each deploy is named from its own data, never from the service's source as it is now", () => {
  // Two upload deploys: the service's label is the newest archive, each row keeps its own.
  const upload = { type: "upload", label: "app-v2.zip" };
  const v1 = { ...base, generation: 1, source: "app-v1.zip" };
  const v2 = { ...base, generation: 2, source: "app-v2.zip" };
  expect([v2, v1].map((d) => deploymentTitle(d, upload))).toEqual(["Deploy from app-v2.zip", "Deploy from app-v1.zip"]);
  // An upload deploy whose archive name is gone: the generation, not the newest archive.
  expect(deploymentTitle({ ...v1, source: null }, upload)).toBe("Generation 1");

  // A clone of "mian" failed; the branch is "main" now. The old row still names what it tried.
  const failed = { ...base, source: "mian", error: "could not fetch mian - check the address (exit status 128)" };
  expect(deploymentTitle(failed, { type: "git", label: "git.example.com/acme/api" })).toBe("Deploy from mian");

  // An inline Dockerfile is the same on every deploy, so its label may name one.
  expect(deploymentTitle({ ...base, source: null }, { type: "inline", label: "Dockerfile" })).toBe("Deploy from Dockerfile");
});

test("the commit wins when known, then rollbacks, moves and pulled images", () => {
  const commit = { sha: "3b8d2aa00", message: "Queue retries with backoff\n\nLonger body", branch: "main", author: null };
  expect(deploymentTitle({ ...base, commit }, github)).toBe("Queue retries with backoff");
  // A commit the panel found by ls-remote has no message: its branch, and the sha shows next to the title.
  expect(deploymentTitle({ ...base, commit: { ...commit, message: "", branch: "release" } }, github)).toBe("Deploy from release");
  expect(deploymentTitle({ ...base, trigger: "rollback" }, github)).toBe("Rollback");
  expect(deploymentTitle({ ...base, trigger: "move" }, github)).toBe("Move to another node");
  const pulled = {
    ...base,
    source: null,
    builder: null,
    builtOn: null,
    image: { ...base.image, reference: "ghcr.io/acme/api:1.4" },
  } as Deployment;
  expect(deploymentTitle(pulled, { type: "image", label: "ghcr.io/acme/api:1.4" })).toBe("Deploy ghcr.io/acme/api:1.4");
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
