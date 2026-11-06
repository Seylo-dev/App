import { expect, test } from "bun:test";
import { allOps, unredactedPaths } from "../src";

// A database URL carries the password (postgres://user:pw@host, the
// ClickHouse HTTP URL, ...) and an edge link is a one-time sign-in, so every
// URL or password a databases op returns must be redacted before it reaches
// a model host, an approval or the audit log. lintOp only knows names like
// "password"; this covers the URLs, so the next engine's extra URL cannot
// leak through MCP or the assistant.
const credentialLike = (key: string) => /(url|password)$/i.test(key);

const databaseOps = allOps.filter((op) => op.id.startsWith("databases."));

test("there are databases ops to check", () => {
  expect(databaseOps.map((op) => op.id)).toContain("databases.connection");
});

for (const op of databaseOps) {
  test(`${op.id} redacts every URL and password it returns`, () => {
    expect(unredactedPaths(op, "output", credentialLike)).toEqual([]);
  });
}

test("the check finds a URL field nobody listed", () => {
  const connection = databaseOps.find((op) => op.id === "databases.connection");
  if (!connection) throw new Error("databases.connection is missing");
  const unlisted = { ...connection, sensitive: { output: ["internal.url", "internal.password", "exposed.url", "exposed.password"] } };
  expect(unredactedPaths(unlisted, "output", credentialLike)).toEqual(["internal.httpUrl"]);
});
