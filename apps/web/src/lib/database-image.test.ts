import { expect, test } from "bun:test";
import { OpError } from "@seylo/ops";
import { imageLine, isFloatingImage, riskRefusalOf } from "./database-image";

test("a tag floats unless it names an exact release or a digest pins it", () => {
  for (const [engine, image, variant, floating] of [
    ["mongo", "mongo:8.2.12", null, false],
    ["mongo", "mongo:8.2", null, true],
    ["mongo", "mongo:latest", null, true],
    ["mongo", "mongo", null, true],
    ["mongo", "docker.io/library/mongo:8.0.40-noble", null, false],
    ["mongo", `mongo@sha256:${"a".repeat(64)}`, null, false],
    ["mongo", `mongo:latest@sha256:${"a".repeat(64)}`, null, false],
    ["postgres", "postgres:17.6-alpine", null, false],
    ["postgres", "postgres:17-alpine", null, true],
    ["postgres", "postgres:9.6", null, true],
    ["postgres", "postgres:9.6.24", null, false],
    ["postgres", "pgvector/pgvector:0.8.7-pg17-trixie", "pgvector", false],
    ["postgres", "pgvector/pgvector:pg17", "pgvector", true],
    ["clickhouse", "clickhouse/clickhouse-server:26.8", null, true],
    ["clickhouse", "clickhouse/clickhouse-server:26.8.36.3", null, false],
    ["keydb", "eqalpha/keydb:x86_64_v6.3.4", null, false],
    ["dragonfly", "ghcr.io/dragonflydb/dragonfly:v1.34.1", null, false],
    ["valkey", "valkey/valkey:9", null, true],
  ] as const) {
    expect({ image, floating: isFloatingImage(engine, image, variant) }).toEqual({ image, floating });
  }
});

test("a riskNotAccepted refusal gives its risks, the line and whether a backup is needed", () => {
  const error = new OpError("CONFLICT", "MongoDB 8.2 is not in Seylo's catalog... Nothing changed.", {
    reason: "riskNotAccepted",
    risk: "otherLine",
    risks: "otherLine,floatingTag",
    message: "MongoDB 8.2 is not in Seylo's catalog...",
    version: "8.2",
    image: "mongo:8.2",
    backupRequired: "true",
  });
  expect(riskRefusalOf(error)).toEqual({
    risk: "otherLine",
    risks: ["otherLine", "floatingTag"],
    message: "MongoDB 8.2 is not in Seylo's catalog...",
    version: "8.2",
    image: "mongo:8.2",
    backupRequired: true,
  });
  expect(riskRefusalOf(new OpError("CONFLICT", "x", { reason: "backupRequired" }))).toBeNull();
  expect(riskRefusalOf(new Error("x"))).toBeNull();
});

test("the line an image is recorded as: the catalog's, the one its tag names, else custom", () => {
  const mysql = [
    { version: "8.4", image: "mysql:8.4.6" },
    { version: "8.0", image: "mysql:8.0.43" },
  ];
  const pgvector = [{ version: "17", image: "pgvector/pgvector:0.8.1-pg17" }];
  for (const [engine, image, catalog, variant, line] of [
    ["mysql", "mysql:8.4.5", mysql, null, "8.4"],
    ["mysql", "docker.io/library/mysql:8.4.6", mysql, null, "8.4"],
    ["mysql", "mysql:9.1.0", mysql, null, "9.1"],
    ["mysql", "mysql:8.4", mysql, null, "8.4"],
    ["mysql", "mysql:8", mysql, null, "custom"],
    ["mysql", "mysql:latest", mysql, null, "custom"],
    ["mysql", "mysql", mysql, null, "custom"],
    ["mysql", `mysql@sha256:${"a".repeat(64)}`, mysql, null, "custom"],
    ["mongo", `mongo:8.0.40@sha256:${"a".repeat(64)}`, [], null, "8.0"],
    ["postgres", "postgres:17.9-bookworm", [], null, "17"],
    ["postgres", "postgres:9.6.24", [], null, "9.6"],
    ["postgres", "pgvector/pgvector:0.8.8-pg16-trixie", pgvector, "pgvector", "16"],
    ["postgres", "pgvector/pgvector:latest", pgvector, "pgvector", "custom"],
    ["keydb", "eqalpha/keydb:x86_64_v6.3.4", [], null, "6.3"],
    ["dragonfly", "ghcr.io/dragonflydb/dragonfly:v1.34.1", [], null, "1.34"],
  ] as const) {
    expect({ image, line: imageLine(engine, image, catalog, variant) }).toEqual({ image, line });
  }
});
