// The VM test of the Users tab runs the panel's own scripts: the committed
// fixture (go/internal/backup/testdata/database-users.json) must be what
// database-users-vm.ts builds now. UPDATE_VM_FIXTURES=1 rewrites it. The
// list outputs the VM test recorded from the real images
// (testdata/database-users-out, SEYLO_IT_RECORD=1) go through the
// panel's parser here.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseListing } from "../src/modules/databases/user-scripts";
import { type VmEngine, vmEngines, vmFixture, vmValues } from "./database-users-vm";

const testdata = join(import.meta.dir, "../../../go/internal/backup/testdata");
const fixturePath = join(testdata, "database-users.json");

test("the VM fixture is what the panel sends", () => {
  const text = `${JSON.stringify(vmFixture(), null, 2)}\n`;
  if (process.env.UPDATE_VM_FIXTURES === "1") writeFileSync(fixturePath, text);
  expect(readFileSync(fixturePath, "utf8")).toBe(text);
  // No step carries a password in its command: they go on stdin.
  for (const scenario of vmFixture().scenarios)
    for (const step of scenario.steps)
      for (const word of step.command) expect(word).not.toMatch(/Password\d{3}|Password\d[a-z]|DbAdminPassword|SAdminPassword/);
});

/** What each recorded list must show, by step. */
const expected: Record<string, (engine: VmEngine) => string[]> = {
  list1: (engine) => [vmValues.reader, vmValues.writer, vmValues.serverAdmin, ...(engine === "postgres" ? [] : [vmValues.dbAdmin])],
  list2: (engine) => [...(engine === "postgres" ? [] : [vmValues.writer2])],
  listAfter: () => [vmValues.newMain],
};

describe("list outputs of the real images", () => {
  for (const engine of vmEngines) {
    for (const [stepName, names] of Object.entries(expected)) {
      const path = join(testdata, "database-users-out", `${engine}-${stepName}.txt`);
      test.skipIf(!existsSync(path))(`${engine} ${stepName}`, () => {
        const listing = parseListing(engine, readFileSync(path, "utf8"), vmValues.database);
        const listed = listing.users.map((u) => u.name);
        for (const name of names(engine)) expect(listed).toContain(name);
        if (stepName === "list2") expect(listed).not.toContain(vmValues.reader);
        const access = (name: string) => listing.users.find((u) => u.name === name)?.access;
        if (stepName === "list1") {
          expect(access(vmValues.reader)).toBe("readOnly");
          expect(access(vmValues.writer)).toBe("readWrite");
          if (engine !== "postgres") expect(access(vmValues.dbAdmin)).toBe("databaseAdmin");
          expect(access(vmValues.serverAdmin)).toBe("serverAdmin");
          expect(listing.users.find((u) => u.name === vmValues.serverAdmin)?.fullRights).toBe(true);
          expect(listing.users.find((u) => u.name === vmValues.writer)?.fullRights).toBe(false);
        }
        if (engine === "postgres" && stepName === "list1") {
          expect(listing.serverVersion).toBeGreaterThanOrEqual(180000);
          // "other" is the server admin's new database.
          expect(listing.databases).toEqual(["app", "other", "postgres", "template1"]);
          const main = listing.users.find((u) => u.name === "postgres");
          expect(main).toMatchObject({ bootstrap: true, fullRights: true, passwordKind: "scram" });
          expect(listing.users.find((u) => u.name === vmValues.reader)?.passwordKind).toBe("scram");
        }
        if ((engine === "mysql" || engine === "mariadb") && stepName === "list1") {
          expect(listing.users.find((u) => u.name === vmValues.reader)?.host).toBe("%");
          expect(listing.users.find((u) => u.name === "root" && u.host === "localhost")).toBeDefined();
        }
        if (engine === "clickhouse" && stepName === "listAfter")
          expect(listing.users.find((u) => u.name === vmValues.newMain)?.storage).toBe("users_xml");
      });
    }
  }
});
