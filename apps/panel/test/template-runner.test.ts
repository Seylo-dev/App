import { describe, expect, test } from "bun:test";
import { runTemplate } from "../src/template-runner/runner";

const ok = `
import { randomPassword, ref, PRIMARY_DOMAIN } from "~templates-utils";
import type { Input } from "./meta";
export function generate(input: Input) {
  const pw: string = randomPassword(20);
  return { services: [
    { type: "postgres", data: { serviceName: input.serviceName + "-db", password: pw } },
    { type: "app", data: { serviceName: input.serviceName, source: { type: "image", image: "nginx:1.27" },
      env: "DB=" + ref(input.serviceName + "-db", "INTERNAL_URL"), domains: [{ host: PRIMARY_DOMAIN, port: 80 }] } },
  ] };
}`;

describe("template runner", () => {
  test("runs TypeScript generate() with the utils module", async () => {
    const out = await runTemplate(ok, { serviceName: "web" });
    expect(out.services.map((s) => s.data.serviceName)).toEqual(["web-db", "web"]);
    const db = out.services[0];
    expect(db?.type === "postgres" && db.data.password?.length).toBe(20);
    const app = out.services[1];
    expect(app?.type === "app" && app.data.env).toBe("DB=${{web-db.INTERNAL_URL}}");
  });

  test("passwords differ between runs", async () => {
    const a = await runTemplate(ok, { serviceName: "web" });
    const b = await runTemplate(ok, { serviceName: "web" });
    const passwordOf = (out: typeof a) => (out.services[0]?.data as { password?: string } | undefined)?.password;
    expect(passwordOf(a)).toHaveLength(20);
    expect(passwordOf(a)).not.toBe(passwordOf(b));
  });

  test("endless loops stop at the time limit", async () => {
    await expect(runTemplate("export function generate() { for (;;) {} }", {}, { timeoutMs: 100 })).rejects.toThrow("time limit");
  });

  test("memory bombs stop at the memory limit", async () => {
    const bomb = "export function generate() { const a = []; for (;;) a.push('x'.repeat(1e5)); }";
    await expect(runTemplate(bomb, {}, { memoryBytes: 8 * 1024 * 1024, timeoutMs: 5000 })).rejects.toThrow("generate() failed");
  });

  test("no host access: no imports, no fetch, no process", async () => {
    await expect(runTemplate('import fs from "fs"; export function generate() { return fs; }', {})).rejects.toThrow();
    await expect(runTemplate("export function generate() { return fetch('http://x'); }", {})).rejects.toThrow("fetch");
    await expect(runTemplate("export function generate() { return process.env; }", {})).rejects.toThrow("process");
  });

  test("invalid output is refused with the path", async () => {
    await expect(
      runTemplate("export function generate() { return { services: [{ type: 'app', data: { serviceName: 'Bad Name' } }] }; }", {}),
    ).rejects.toThrow("invalid result");
    await expect(runTemplate("export const x = 1;", {})).rejects.toThrow("generate");
  });
});
