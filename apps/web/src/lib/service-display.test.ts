import { describe, expect, test } from "bun:test";
import { isBusy, kindTag, lastActivity, placementLine, sourceLine, statusDisplay } from "./service-display";

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
});
