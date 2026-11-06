import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { allOps } from "@seylo/ops";
import { Elysia } from "elysia";
import { modules } from "../src/modules/index.gen";
import { defineModule } from "../src/modules/module";
import { collectHandlers } from "../src/ops/handlers";
import { testPanel } from "./helpers";

test("every op contract has exactly one handler, and every handler a contract", () => {
  const handlers = collectHandlers(modules);
  // Both sorted the same way: allOps sorts by locale, which orders "gitProviders" after "github".
  expect([...handlers.keys()].sort()).toEqual(allOps.map((op) => op.id).sort());
});

test("module names match their folders", () => {
  const folders = readdirSync(join(import.meta.dir, "../src/modules"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(modules.map((m) => m.name).sort()).toEqual(folders);
});

test("module http endpoints are served and start hooks run before serving", async () => {
  let startedWith: string | undefined;
  const hooks = defineModule({
    name: "hooks",
    ops: [],
    http: () => new Elysia().get("/api/hooks/ping", () => "pong"),
    start: (deps) => {
      startedWith = deps.panelId;
    },
  });
  const panel = testPanel({ modules: [...modules, hooks] });
  try {
    expect(startedWith).toBe(panel.deps.panelId);
    const response = await panel.app.handle(new Request("http://localhost/api/hooks/ping"));
    expect(await response.text()).toBe("pong");
  } finally {
    panel.close();
  }
});
