import { expect, test } from "bun:test";
import { nodeRangeStorage, readNodeRange, saveNodeRange } from "./dashboard-range";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

test("the Nodes card starts on Live", () => {
  expect(readNodeRange(memoryStorage())).toBe("live");
  expect(readNodeRange(null)).toBe("live");
});

test("each person's last choice comes back in this browser", () => {
  const storage = memoryStorage();
  saveNodeRange("24h", storage);
  expect(storage.items.get(nodeRangeStorage)).toBe("24h");
  expect(readNodeRange(storage)).toBe("24h");
  saveNodeRange("live", storage);
  expect(readNodeRange(storage)).toBe("live");
});

test("a value it does not know, or storage that throws, means Live", () => {
  const storage = memoryStorage();
  storage.items.set(nodeRangeStorage, "30d");
  expect(readNodeRange(storage)).toBe("live");
  const blocked = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  expect(readNodeRange(blocked)).toBe("live");
  expect(() => saveNodeRange("7d", blocked)).not.toThrow();
});
