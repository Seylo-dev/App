// A backup whose destination was deleted (Settings > Backups): the panel
// has no keys for that bucket, so the row says "Destination deleted",
// offers no Restore, and its Delete becomes Remove from list, whose dialog
// says the file stays in the bucket. Before, the row offered Restore and
// Delete like any other, both failed, and the error landed under the
// card's last row.

import { expect, test } from "bun:test";
import { t } from "../../../i18n/t";
import { renderStatic } from "../../../test/render";
import { deleteRunCopy, type Run, RunRow, runActions } from "./run-row";

const run = (over: Partial<Run> = {}): Run => ({
  id: "r000000000000001",
  kind: "backup",
  serviceId: "s000000000000001",
  policyId: "b000000000000001",
  destinationId: "x000000000000001",
  target: "database",
  volumeId: null,
  sourceRunId: null,
  status: "succeeded",
  objectKey: "seylo/s000000000000001/b000000000000001/20261112T211900Z-r000000000000001.dump",
  sizeBytes: 18_400_000,
  error: null,
  deletedAt: null,
  startedAt: "2026-11-12T21:19:00.000Z",
  finishedAt: "2026-11-12T21:19:12.000Z",
  ...over,
});

const render = (r: Run) => renderStatic(() => <RunRow run={r} onRestore={() => {}} onDelete={() => {}} />);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const actionsButton = `aria-label="${t("serviceBackups.actions")}"`;

test("a backup is restorable while its destination exists; once that is deleted only Remove from list is left", () => {
  expect(runActions(run())).toBe("restorable");
  expect(runActions(run({ destinationId: null }))).toBe("destinationGone");
  // Deleted, failed, running and restore runs have nothing to do, with or without a destination.
  for (const over of [
    { deletedAt: "2026-11-13T08:00:00.000Z" },
    { deletedAt: "2026-11-13T08:00:00.000Z", destinationId: null },
    { status: "failed" as const, destinationId: null },
    { status: "running" as const },
    { kind: "restore" as const, destinationId: null },
  ])
    expect(runActions(run(over))).toBe("none");
});

test("the row of a backup whose destination was deleted says so and keeps its menu", async () => {
  const html = await render(run({ destinationId: null }));
  expect(text(html)).toContain(t("serviceBackups.destinationDeleted"));
  expect(html).toContain(actionsButton);

  const normal = await render(run());
  expect(text(normal)).not.toContain(t("serviceBackups.destinationDeleted"));
  expect(normal).toContain(actionsButton);
});

test("once removed from the list the row reads Deleted, with no menu and no destination chip", async () => {
  const html = await render(run({ destinationId: null, deletedAt: "2026-11-13T08:00:00.000Z" }));
  expect(text(html)).toContain(t("serviceBackups.deleted"));
  expect(text(html)).not.toContain(t("serviceBackups.destinationDeleted"));
  expect(html).not.toContain(actionsButton);
});

test("the delete dialog: Delete removes the file from the bucket, Remove from list says the file stays there", () => {
  const forget = deleteRunCopy(run({ destinationId: null }));
  expect(forget).toEqual({
    title: "Remove this backup from the list?",
    description: t("serviceBackups.forgetRunBody"),
    confirmLabel: "Remove from list",
  });
  expect(forget.description).toContain("the file stays in the bucket");
  expect(forget.description).toContain("delete it there by hand");

  const remove = deleteRunCopy(run());
  expect(remove).toEqual({
    title: "Delete this backup?",
    description: t("serviceBackups.deleteRunBody"),
    confirmLabel: t("service.remove"),
  });
  // While the dialog has no run (never shown with one), it reads as the plain delete.
  expect(deleteRunCopy(null)).toEqual(remove);
});
