// The panel's address classifier (uptime/targets.ts blockedReason) and the
// agent's (go/internal/netguard Classify) read one table, so a range added
// on one side only fails a test. The Go side (TestSharedAddressTable) also
// fails when a netguard rule has no case in it. Before, the panel missed
// 6to4, IPv4-compatible, site-local and the documentation ranges.

import { expect, test } from "bun:test";
import table from "../../../go/internal/netguard/testdata/addresses.json";
import { blockedReason } from "../src/modules/uptime/targets";

type Case = { address: string; class: "public" | "internal" | "metadata"; reason?: string };

test("blockedReason agrees with netguard on every address of the shared table", () => {
  const cases = table.cases as Case[];
  expect(cases.length).toBeGreaterThan(100);
  const wrong = cases
    .map((c) => ({ ...c, got: blockedReason(c.address) }))
    .filter((c) => c.got !== (c.class === "public" ? null : (c.reason ?? "missing")))
    .map((c) => `${c.address}: ${c.got ?? "public"}, the table says ${c.class}${c.reason ? ` (${c.reason})` : ""}`);
  expect(wrong).toEqual([]);
  // Brackets, as hosts of URLs carry them, change nothing.
  expect(blockedReason("[2002:7f00:1::1]")).toBe("loopback");
  expect(blockedReason("[fec0::1]")).toBe("private");
});
