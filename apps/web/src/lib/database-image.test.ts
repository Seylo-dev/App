import { expect, test } from "bun:test";
import { OpError } from "@seylo/ops";
import { imageLine, isFloatingImage, riskRefusalOf, riskWords, tagReleaseOf } from "./database-image";

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
  const error = new OpError("CONFLICT", "mongo:8.2 is MongoDB 8.2. Seylo does not offer MongoDB 8.2... Nothing changed.", {
    reason: "riskNotAccepted",
    risk: "otherLine",
    risks: "otherLine,floatingTag",
    message: "mongo:8.2 is MongoDB 8.2. Seylo does not offer MongoDB 8.2...",
    version: "8.2",
    image: "mongo:8.2",
    backupRequired: "true",
  });
  expect(riskRefusalOf(error)).toEqual({
    risk: "otherLine",
    risks: ["otherLine", "floatingTag"],
    message: "mongo:8.2 is MongoDB 8.2. Seylo does not offer MongoDB 8.2...",
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

test("a risk's words name what the tag is: the line Seylo does not offer, what a floating tag moves to", () => {
  const lines = ["9.0", "8.0", "7.0"];
  const runs = { image: "mongo:8.0.38", version: "8.0" };
  const off = { image: "mongo:8.2.12", version: "8.2" };
  // The target's line is the one outside the catalog; else the one that runs.
  expect(riskWords("otherLine", "mongo", off, runs, lines)).toEqual({
    key: "otherLine",
    image: "mongo:8.2.12",
    version: "8.2",
    release: "",
  });
  expect(riskWords("otherLine", "mongo", { image: "mongo:9.0.8", version: "9.0" }, off, lines)).toEqual({
    key: "otherLineRuns",
    image: "mongo:8.2.12",
    version: "8.2",
    release: "",
  });
  // A floating target moves to each new release of the one its tag names, or to each new one.
  expect(riskWords("floatingTag", "mongo", { image: "mongo:8.2", version: "8.2" }, runs, lines)).toMatchObject({
    key: "floatingTag",
    image: "mongo:8.2",
    release: "8.2",
  });
  expect(riskWords("floatingTag", "mongo", { image: "mongo:latest", version: "custom" }, runs, lines)).toMatchObject({
    key: "floatingTagAny",
    image: "mongo:latest",
  });
  const pgvector = { image: "pgvector/pgvector:pg17", version: "17" };
  expect(riskWords("floatingTag", "postgres", pgvector, runs, lines, "pgvector")).toMatchObject({ key: "floatingTagAny" });
  // An exact target: what runs floats.
  expect(riskWords("floatingTag", "mongo", runs, { image: "mongo:8", version: "custom" }, lines)).toEqual({
    key: "floatingTagRuns",
    image: "mongo:8",
    version: "",
    release: "",
  });
  // Every other risk keeps its own words and the target's image.
  expect(riskWords("downgrade", "mongo", { image: "mongo:7.0.45", version: "7.0" }, runs, lines)).toMatchObject({
    key: "downgrade",
    image: "mongo:7.0.45",
  });
  expect(tagReleaseOf("postgres:17-alpine")).toBe("17");
  expect(tagReleaseOf(`mongo@sha256:${"a".repeat(64)}`)).toBeNull();
  expect(tagReleaseOf("mongo")).toBeNull();
});
