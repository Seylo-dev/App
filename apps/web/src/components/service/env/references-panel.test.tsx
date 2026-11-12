import { expect, test } from "bun:test";
import type { AnalyzeContext } from "@seylo/env-analyzer";
import { renderStatic } from "../../../test/render";
import { buildsFromRepository, ReferencesPanel } from "./references-panel";

const context: AnalyzeContext = { self: { serviceId: "svc00000000000001", name: "api", nodes: [] }, targets: [] };

const panel = (builtFromRepository: boolean) =>
  renderStatic(() => (
    <ReferencesPanel
      context={context}
      projectId="prj00000000000001"
      reveal={false}
      builtFromRepository={builtFromRepository}
      onInsert={() => {}}
    />
  ));

test("a service built from a repository is told about GIT_SHA next to its references", async () => {
  // Before 0.2.14 nothing set GIT_SHA, and nothing said so.
  expect(await panel(true)).toContain("GIT_SHA, the commit this deployment was built from");
  expect(await panel(false)).not.toContain("GIT_SHA");
});

test("repository sources are the ones whose deploys build a commit", () => {
  for (const type of ["github", "provider", "git"]) expect(buildsFromRepository({ type })).toBe(true);
  for (const type of ["image", "inline", "upload", "none"]) expect(buildsFromRepository({ type })).toBe(false);
});
