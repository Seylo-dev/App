import { expect, test } from "bun:test";
import { tabsFor } from "./service-tabs";

// A compose stack or a cron service takes no domains, so it has no Domains
// tab; one that has domains from before (the API did not check) shows the
// tab for them, where each says it routes nowhere and where it belongs.
test("compose stacks and cron services show the Domains tab only for domains they already have", () => {
  const paths = (kind: Parameters<typeof tabsFor>[0], strayDomains?: boolean) => tabsFor(kind, { strayDomains }).map((t) => t.path);
  expect(paths("compose")).not.toContain("domains");
  expect(paths("cron")).not.toContain("domains");
  expect(paths("compose", true)).toEqual(["", "source", "domains", "notes", "settings"]);
  expect(paths("cron", true).slice(0, 5)).toEqual(["", "deployments", "source", "environment", "domains"]);
  // Apps always have it, once.
  expect(paths("app", true).filter((p) => p === "domains")).toHaveLength(1);
});

// A database moves to another node from its Advanced tab (0.2.16), like apps and cron services.
test("every database engine has an Advanced tab, before Notes", () => {
  for (const kind of ["postgres", "mysql", "mariadb", "mongo", "redis", "valkey", "keydb", "dragonfly", "clickhouse"] as const) {
    const paths = tabsFor(kind).map((t) => t.path);
    expect(paths.slice(-3)).toEqual(["advanced", "notes", "settings"]);
  }
});
