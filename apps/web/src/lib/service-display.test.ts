import { describe, expect, test } from "bun:test";
import { deploysOnPush, isBusy, kindTag, lastActivity, placementLine, sourceLine, statusDisplay } from "./service-display";

describe("service display", () => {
  test("kind tags", () => {
    expect(kindTag({ kind: "postgres", templateSlug: null, protected: false }).label).toBe("PG");
    expect(kindTag({ kind: "app", templateSlug: "n8n", protected: false }).label).toBe("TPL");
    expect(kindTag({ kind: "app", templateSlug: null, protected: true }).label).toBe("SYS");
  });

  test("statuses", () => {
    expect(statusDisplay("running")).toMatchObject({ label: "Running", tone: "green", dot: "ok" });
    expect(statusDisplay("crashed").dot).toBe("error");
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
    expect(statusDisplay("building", true)).toMatchObject({ label: "Waiting for a build slot", tone: "gray", dot: "off" });
    expect(statusDisplay("building", false).label).toBe("Building");
    expect(statusDisplay("running", true).label).toBe("Running");
    const waiting = { status: "building" as const, buildWaiting: true, liveDeployment: null, lastDeployedAt: null };
    expect(lastActivity({ ...waiting, createdAt: new Date().toISOString() })).toBe("waiting for a build slot");
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
