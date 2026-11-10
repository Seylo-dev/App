// The Machine card's Docker version and the Update Docker button follow the
// node's docker (the agent's own check for a newer Docker Engine): amber
// with a question mark when one is there, the button off when nothing
// newer is, and as before when nothing is known.

import { expect, test } from "bun:test";
import { TooltipProvider } from "@seylo/ui/components/tooltip";
import { t } from "../../i18n/t";
import type { NodeRow } from "../../lib/types";
import { renderStatic } from "../../test/render";
import { DockerUpdateButton, DockerVersion, dockerUpdateBlocked, dockerVersionTip } from "./docker-version";

type NodeDocker = NonNullable<NodeRow["docker"]>;

const hour = 3600_000;
const docker = (over: Partial<NodeDocker> = {}): NodeDocker => ({
  version: "29.9.3",
  latest: "29.9.3",
  updateAvailable: false,
  checkedAt: new Date(Date.now() - 2 * hour - 60_000).toISOString(),
  reason: null,
  ...over,
});
const available = docker({ latest: "29.9.4", updateAvailable: true });
const notPackaged = docker({
  latest: null,
  updateAvailable: null,
  reason: "Docker Engine was not installed with apt (static binaries or snap, for example), so the agent cannot update it.",
});

const version = (value?: NodeDocker) =>
  renderStatic(() => (
    <TooltipProvider>
      <DockerVersion version="29.9.3" docker={value} />
    </TooltipProvider>
  ));

const node = (value: NodeDocker | undefined, status: NodeRow["status"] = "online") =>
  ({ id: "n1", name: "de-fsn-1", status, ...(value ? { docker: value } : {}) }) as NodeRow;
const button = (value: NodeDocker | undefined, status?: NodeRow["status"], pending = false) =>
  renderStatic(() => <DockerUpdateButton node={node(value, status)} pending={pending} onClick={() => {}} />);
// The markup escapes apostrophes.
const html = (text: string) => text.replaceAll("'", "&#x27;");

test("a newer Docker turns the version amber with a question mark that says which", async () => {
  const out = await version(available);
  expect(out).toContain('data-docker-update="available"');
  expect(out).toContain("text-chip-amber-fg");
  // The question mark is a button, so the keyboard reaches its tooltip too.
  expect(out).toContain(`<button type="button" aria-label="${html("Docker 29.9.4 is available. Update it from this node's actions.")}"`);
  expect(dockerVersionTip(available)).toBe("Docker 29.9.4 is available. Update it from this node's actions.");
});

test("up to date, or nothing known: the version as before", async () => {
  for (const value of [docker(), undefined, docker({ updateAvailable: null })]) {
    const out = await version(value);
    expect(out).toBe("29.9.3");
  }
});

test("Docker the agent cannot update keeps its tone and says why on the question mark", async () => {
  const out = await version(notPackaged);
  expect(out).not.toContain("text-chip-amber-fg");
  expect(out).toContain(`aria-label="${notPackaged.reason}"`);
});

test("Update Docker is off with the reason when there is nothing newer", async () => {
  const out = await button(docker());
  expect(out).toContain(` disabled=""`);
  expect(out).toContain('title="Docker is up to date (29.9.3, checked 2 h ago)"');
  expect(dockerUpdateBlocked(docker())).toBe(t("nodes.dockerUpToDate", { version: "29.9.3", ago: "2 h ago" }));
  // And when the agent cannot update Docker here at all.
  expect(await button(notPackaged)).toContain(`title="${notPackaged.reason}"`);
});

test("Update Docker stays on when an update is there or nothing is known", async () => {
  // An older agent (no docker), a check that stopped answering (null), a newer version.
  for (const value of [undefined, docker({ updateAvailable: null }), available]) {
    const out = await button(value);
    expect(out).not.toContain(` disabled=""`);
    expect(out).not.toContain("title=");
    expect(out).toContain(t("nodes.updateDocker"));
  }
  // Offline, or while its dry run runs, as before.
  expect(await button(available, "offline")).toContain(` disabled=""`);
  expect(await button(available, "online", true)).toContain(` disabled=""`);
});
