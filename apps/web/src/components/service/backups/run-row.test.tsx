// A backup whose destination was deleted (Settings > Backups): the panel
// has no keys for that bucket, so the row says "Destination deleted",
// offers no Restore, and its Delete becomes Remove from list, whose dialog
// says the file stays in the bucket. Before, the row offered Restore and
// Delete like any other, both failed, and the error landed under the
// card's last row.

import { expect, test } from "bun:test";
import { t } from "../../../i18n/t";
import { renderStatic } from "../../../test/render";
import { formatDateTime } from "../format";
import { deleteRunCopy, fileKept, type Run, RunRow, runActions, runLabel, runMenu } from "./run-row";

const run = (over: Partial<Run> = {}): Run => ({
  id: "r000000000000001",
  kind: "backup",
  serviceId: "s000000000000001",
  policyId: "b000000000000001",
  destinationId: "x000000000000001",
  target: "database",
  volumeId: null,
  volumeName: null,
  sourceRunId: null,
  sourceStartedAt: null,
  status: "succeeded",
  objectKey: "seylo/s000000000000001/b000000000000001/20261112T211900Z-r000000000000001.dump",
  sizeBytes: 18_400_000,
  error: null,
  deletedAt: null,
  startedAt: "2026-11-12T21:19:00.000Z",
  finishedAt: "2026-11-12T21:19:12.000Z",
  ...over,
});

const render = (r: Run) => renderStatic(() => <RunRow run={r} onRestore={() => {}} onDownload={() => {}} onDelete={() => {}} />);
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

test("a Delete whose destination was deleted meanwhile is told the file stayed in the bucket", () => {
  const removed = { deletedAt: "2026-11-13T08:00:00.000Z" };
  // The list still showed the destination, the panel answered without one: only marked deleted.
  expect(fileKept(run(), run({ ...removed, destinationId: null }))).toBe(true);
  // A plain delete took the file out of the bucket; Remove from list already said the file stays.
  expect(fileKept(run(), run(removed))).toBe(false);
  expect(fileKept(run({ destinationId: null }), run({ ...removed, destinationId: null }))).toBe(false);
});

// Before, a row showed only its date, size and duration: with two volume
// schedules (vault-warden's data and web-vault) nothing said which backup
// was which.
test("each row names what it backed up, and a restore which backup it restored", async () => {
  const volume = run({ target: "volume", volumeId: "v000000000000001", volumeName: "web-vault" });
  expect(runLabel(run())).toBe("Database");
  expect(runLabel(volume)).toBe("Volume web-vault");
  // The volume was deleted since (its id is cleared with it).
  expect(runLabel(run({ target: "volume", volumeId: null, volumeName: null }))).toBe("Deleted volume");
  const restored = "2026-11-12T03:00:00.000Z";
  expect(runLabel(run({ kind: "restore", sourceRunId: "r000000000000009", sourceStartedAt: restored }))).toBe(
    `Restore of the ${formatDateTime(restored)} backup of Database`,
  );
  expect(runLabel({ ...volume, kind: "restore", sourceRunId: "r000000000000009", sourceStartedAt: restored })).toBe(
    `Restore of the ${formatDateTime(restored)} backup of Volume web-vault`,
  );
  expect(runLabel(run({ kind: "restore", sourceRunId: null }))).toBe("Restore of a backup of Database");

  // Next to the date, also on rows with nothing to do.
  const html = text(await render(volume));
  expect(html).toContain(`${formatDateTime(volume.startedAt)} Volume web-vault`);
  expect(text(await render(run({ status: "failed", error: "S3 said no" })))).toContain("Database");
});

test("Download sits between Restore and Remove for a backup that is there; never for a deleted one or once its destination is gone", () => {
  expect(runMenu(run())).toEqual(["restore", "download", "remove"]);
  expect(runMenu(run({ destinationId: null }))).toEqual(["forget"]);
  for (const over of [
    { deletedAt: "2026-11-13T08:00:00.000Z" },
    { status: "failed" as const },
    { status: "running" as const },
    { kind: "restore" as const },
  ])
    expect(runMenu(run(over))).toEqual([]);
});
