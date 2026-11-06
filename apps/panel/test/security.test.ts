import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMasterKey, MasterKeyError } from "../src/security/master-key";
import { createSecretBox } from "../src/security/secret-box";

const key = () => crypto.getRandomValues(new Uint8Array(32));

describe("secret box", () => {
  test("round-trips a value for the same purpose", () => {
    const box = createSecretBox(key());
    const sealed = box.seal("DATABASE_URL=postgres://u:p@db/app", "service.env");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("postgres");
    expect(box.open(sealed, "service.env")).toBe("DATABASE_URL=postgres://u:p@db/app");
  });

  test("a value sealed for one purpose does not open as another", () => {
    const box = createSecretBox(key());
    expect(box.open(box.seal("x", "service.env"), "totp.secret")).toBeNull();
  });

  test("tampering and a different master key are detected", () => {
    const box = createSecretBox(key());
    const sealed = box.seal("secret", "service.env");
    const parts = sealed.split(".");
    parts[3] = Buffer.from("SECRET").toString("base64url");
    expect(box.open(parts.join("."), "service.env")).toBeNull();
    expect(createSecretBox(key()).open(sealed, "service.env")).toBeNull();
    expect(box.open("garbage", "service.env")).toBeNull();
  });

  test("sealing twice gives different ciphertexts", () => {
    const box = createSecretBox(key());
    expect(box.seal("x", "service.env")).not.toBe(box.seal("x", "service.env"));
  });
});

describe("master key", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "panel-key-"));

  test("is created with mode 0600 on a fresh install and read back", () => {
    const path = join(dir(), "master.key");
    const created = loadMasterKey(path, true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadMasterKey(path, false)).toEqual(created);
  });

  test("is never silently recreated for an existing database", () => {
    const path = join(dir(), "master.key");
    expect(() => loadMasterKey(path, false)).toThrow(MasterKeyError);
    expect(existsSync(path)).toBe(false);
  });

  test("rejects a file that is not a 32-byte key", () => {
    const path = join(dir(), "master.key");
    writeFileSync(path, "c2hvcnQ=\n");
    expect(() => loadMasterKey(path, false)).toThrow(/32-byte/);
    expect(readFileSync(path, "utf8")).toBe("c2hvcnQ=\n");
  });
});
