import { expect, test } from "bun:test";
import { normalizeUserCode } from "./user-code";

test("user codes are cleaned up", () => {
  expect(normalizeUserCode("ABCD-EFGH")).toBe("ABCD-EFGH");
  expect(normalizeUserCode(" abcd efgh ")).toBe("ABCD-EFGH");
  expect(normalizeUserCode("abcdefgh")).toBe("ABCD-EFGH");
});

test("look-alike characters and wrong lengths are refused", () => {
  expect(normalizeUserCode("ABCD-EFG0")).toBeNull();
  expect(normalizeUserCode("ABCD-EFGI")).toBeNull();
  expect(normalizeUserCode("ABC-EFGH")).toBeNull();
  expect(normalizeUserCode("")).toBeNull();
});
