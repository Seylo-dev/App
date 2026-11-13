import { expect, test } from "bun:test";
import type { Deployment } from "../deploy-steps";
import { latestDeployView } from "./latest-deploy";

const t0 = Date.parse("2026-11-13T01:00:00Z");
const row = (generation: number, status: Deployment["status"], minutes: number) =>
  ({
    id: `d0000000000000${String(generation).padStart(2, "0")}`,
    generation,
    status,
    live: status === "live",
    createdAt: new Date(t0 + minutes * 60_000).toISOString(),
  }) as Deployment;
const ids = (d: Deployment | null | undefined) => d?.generation ?? null;

test("a deploy in progress comes first, with the live one under it", () => {
  const view = latestDeployView([row(4, "building", 90), row(3, "live", 60), row(2, "failed", 10)], null);
  expect(view).toMatchObject({ inProgress: true, queuedBehind: 0 });
  expect(ids(view?.main)).toBe(4);
  expect(ids(view?.other)).toBe(3);
});

test("with no live one listed, the newest finished one goes under it", () => {
  // The owner's images-api: gen 3 building after two failed builds.
  const view = latestDeployView([row(3, "building", 88), row(2, "failed", 7), row(1, "failed", 0)], null);
  expect(ids(view?.main)).toBe(3);
  expect(ids(view?.other)).toBe(2);
  expect(latestDeployView([row(1, "queued", 0)], null)).toMatchObject({ inProgress: true, other: null });
});

test("the one in progress is the oldest moving one; the ones queued behind it are counted", () => {
  const view = latestDeployView([row(6, "queued", 95), row(5, "queued", 94), row(4, "building", 90), row(3, "live", 60)], null);
  expect(ids(view?.main)).toBe(4);
  expect(view?.queuedBehind).toBe(2);
  expect(ids(view?.other)).toBe(3);
});

test("the active query adds a deploy the list does not hold, never an older copy of a listed one", () => {
  // A new deploy the card's list has not heard of yet.
  const newer = latestDeployView([row(3, "live", 60), row(2, "failed", 10)], row(4, "building", 90));
  expect(ids(newer?.main)).toBe(4);
  expect(newer?.inProgress).toBe(true);
  expect(ids(newer?.other)).toBe(3);
  // A running deploy older than the card's rows, with newer pushes queued behind it.
  const older = latestDeployView([row(9, "queued", 99), row(8, "queued", 98)], row(7, "building", 97));
  expect(ids(older?.main)).toBe(7);
  expect(older?.queuedBehind).toBe(2);
  // The list says gen 4 is live; the active query still says building: the list wins.
  const done = latestDeployView([row(4, "live", 90), row(3, "superseded", 60)], row(4, "building", 90));
  expect(done).toMatchObject({ inProgress: false, other: null });
  expect(ids(done?.main)).toBe(4);
});

test("nothing in progress: the newest, and the live one when it is another", () => {
  const failedOnTop = latestDeployView([row(5, "failed", 99), row(4, "live", 90)], null);
  expect(failedOnTop).toMatchObject({ inProgress: false, queuedBehind: 0 });
  expect(ids(failedOnTop?.main)).toBe(5);
  expect(ids(failedOnTop?.other)).toBe(4);
  expect(latestDeployView([row(4, "live", 90)], null)?.other).toBeNull();
  expect(latestDeployView([], null)).toBeNull();
});
