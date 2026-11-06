import { describe, expect, test } from "bun:test";
import { checkNewVolume, type Volume, volumeInputs } from "./volumes";

const vol = (over: Partial<Volume>): Volume => ({
  id: "v000000000000001",
  name: "data",
  mountPath: "/data",
  kind: "volume",
  readOnly: false,
  sharedWith: [],
  ...over,
});

describe("volumes", () => {
  test("setVolumes input keeps named volumes and leaves file mounts out", () => {
    const list = [vol({}), vol({ id: "v000000000000002", name: "app.yml", mountPath: "/app.yml", kind: "file", readOnly: true })];
    expect(volumeInputs(list)).toEqual([{ name: "data", mountPath: "/data", readOnly: false }]);
  });

  test("a new volume needs a valid unique name and a free absolute path", () => {
    const list = [vol({})];
    expect(checkNewVolume({ name: "uploads", mountPath: "/app/uploads", readOnly: false }, list)).toBeNull();
    expect(checkNewVolume({ name: "Uploads", mountPath: "/u", readOnly: false }, list)).toBe("nameFormat");
    expect(checkNewVolume({ name: "data", mountPath: "/u", readOnly: false }, list)).toBe("nameTaken");
    expect(checkNewVolume({ name: "u", mountPath: "u", readOnly: false }, list)).toBe("pathFormat");
    expect(checkNewVolume({ name: "u", mountPath: "/data/", readOnly: false }, list)).toBe("pathTaken");
  });
});
