import { describe, expect, test } from "bun:test";
import { deploysOnPush, isBusy, kindTag, lastActivity, placementLine, sourceLine, statusDisplay } from "./service-display";
import type { ServiceStatus } from "./types";

describe("service display", () => {
  test("kind tags", () => {
    expect(kindTag({ kind: "postgres", templateSlug: null, protected: false }).label).toBe("PG");
    expect(kindTag({ kind: "app", templateSlug: "n8n", protected: false }).label).toBe("TPL");
    expect(kindTag({ kind: "app", templateSlug: null, protected: true }).label).toBe("SYS");
  });

  test("statuses", () => {
    expect(statusDisplay({ status: "running" })).toMatchObject({ label: "Running", tone: "green", dot: "ok" });
    expect(statusDisplay({ status: "crashed" }).dot).toBe("error");
    expect(isBusy("building")).toBe(true);
    expect(isBusy("running")).toBe(false);
  });

  test("source lines read like the design", () => {
    expect(sourceLine({ source: { type: "github", label: "acme/shop-web", branch: "main", builder: "railpack" }, address: "x" })).toBe(
      "GitHub acme/shop-web · main · Railpack",
    );
    expect(sourceLine({ source: { type: "database", label: "postgres:17", branch: null, builder: null }, address: null })).toBe(
      "postgres:17 · internal only",
    );
    expect(sourceLine({ source: { type: "database", label: "redis:7.4", branch: null, builder: null }, address: "redis:6379" })).toBe(
      "redis:7.4 · internal only",
    );
  });

  test("placement and last activity", () => {
    const placements = [
      { nodeId: "a", nodeName: "de-fsn-1", replicas: 1 },
      { nodeId: "b", nodeName: "us-ash-1", replicas: 1 },
    ];
    expect(placementLine({ placements })).toBe("de-fsn-1 +1");
    expect(placementLine({ placements: [] })).toBe("no node");
    expect(lastActivity({ status: "building", liveDeployment: null, lastDeployedAt: null, createdAt: new Date().toISOString() })).toBe(
      "building now",
    );
  });

  test("a service whose build waits for a slot says so in lists, not Building", () => {
    // An answer without runtimeStatus (a panel before 0.2.17): the gray dot it always had.
    expect(statusDisplay({ status: "building", buildWaiting: true })).toMatchObject({
      label: "Waiting for a build slot",
      tone: "gray",
      dot: "off",
    });
    expect(statusDisplay({ status: "building", buildWaiting: false }).label).toBe("Building");
    expect(statusDisplay({ status: "running", buildWaiting: true }).label).toBe("Running");
    const waiting = { status: "building" as const, buildWaiting: true, liveDeployment: null, lastDeployedAt: null };
    expect(lastActivity({ ...waiting, createdAt: new Date().toISOString() })).toBe("waiting for a build slot");
  });

  describe("the dot says whether the app is up, the label what a deploy does", () => {
    const live = { id: "d000000000000001", label: "3b8d2aa", createdAt: "2026-11-14T10:00:00Z" };
    type Row = [status: ServiceStatus, waiting: boolean, runtime: ServiceStatus | undefined, live: boolean, label: string, dot: string];
    const rows: Row[] = [
      // A deploy on top of a live version: what runs.
      ["building", true, "running", true, "Waiting for a build slot", "ok"],
      ["building", false, "running", true, "Building", "ok"],
      ["deploying", false, "running", true, "Deploying", "ok"],
      ["building", false, "partial", true, "Building", "busy"],
      ["deploying", false, "starting", true, "Deploying", "busy"],
      ["building", true, "crashed", true, "Waiting for a build slot", "error"],
      ["deploying", false, "unhealthy", true, "Deploying", "error"],
      ["building", true, "stopped", true, "Waiting for a build slot", "off"],
      ["building", false, "unknown", true, "Building", "off"],
      // A first deploy: nothing live, so the deploy's dot; waiting for a slot is pending, not off.
      ["building", true, "idle", false, "Waiting for a build slot", "pending"],
      ["building", false, "idle", false, "Building", "busy"],
      ["deploying", false, "starting", false, "Deploying", "busy"],
      ["deploying", false, "crashed", false, "Deploying", "busy"],
      // No deploy: the status, which is what runs.
      ["running", false, "running", true, "Running", "ok"],
      ["crashed", false, "crashed", true, "Crashed", "error"],
      ["stopped", false, "stopped", true, "Stopped", "off"],
      ["idle", false, "idle", false, "Not deployed", "off"],
      // Panels before 0.2.17 send no runtimeStatus: as before.
      ["building", true, undefined, true, "Waiting for a build slot", "off"],
      ["building", false, undefined, true, "Building", "busy"],
      ["deploying", false, undefined, true, "Deploying", "busy"],
    ];
    for (const [status, waiting, runtime, isLive, label, dot] of rows) {
      test(`${status}${waiting ? " (waiting)" : ""}, runs ${runtime ?? "(not sent)"}, ${isLive ? "live" : "nothing live"}: ${label}, ${dot}`, () => {
        const service = {
          status,
          buildWaiting: waiting,
          liveDeployment: isLive ? live : null,
          ...(runtime ? { runtimeStatus: runtime } : {}),
        };
        expect(statusDisplay(service)).toMatchObject({ label, dot });
      });
    }
  });

  test("deploy on push for every source that has the switch", () => {
    expect(deploysOnPush({ type: "github", deployOnPush: true })).toBe(true);
    expect(deploysOnPush({ type: "git", deployOnPush: false })).toBe(false);
    // GitLab, Gitea and Bitbucket sources (new in 0.2) have it too.
    expect(deploysOnPush({ type: "provider", deployOnPush: true })).toBe(true);
    expect(deploysOnPush({ type: "image" })).toBeNull();
    expect(deploysOnPush({ type: "none" })).toBeNull();
  });
});
