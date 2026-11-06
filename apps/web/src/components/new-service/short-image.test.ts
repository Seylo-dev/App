import { expect, test } from "bun:test";
import { shortImage } from "./short-image";

test("digest pins show their first 12 hex characters, tags stay as they are", () => {
  expect(shortImage("eqalpha/keydb@sha256:6537505c42355ca1f571276bddf83f5b750f760f07b2a185a676481791e388ac")).toBe(
    "eqalpha/keydb@sha256:6537505c4235…",
  );
  expect(shortImage("clickhouse/clickhouse-server:26.3.62.3")).toBe("clickhouse/clickhouse-server:26.3.62.3");
  expect(shortImage("odd@sha256:short")).toBe("odd@sha256:short");
});
