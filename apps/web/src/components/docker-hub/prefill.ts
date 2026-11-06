// What the Docker Hub form starts with, from an image's config: the service
// name, the main port, the env text (the image's own ENV, without the
// build-time noise, secret-looking names left empty) and the volumes.
// Pure functions, so the form and the tests read the same rules.

import { isSecretName, stringifyEnv } from "@seylo/env-analyzer";
import type { dockerHub, OpOutput } from "@seylo/ops";

export type ImageConfig = OpOutput<typeof dockerHub.inspect>;
export type SearchResult = OpOutput<typeof dockerHub.search>["results"][number];
export type TagInfo = OpOutput<typeof dockerHub.tags>["tags"][number];

/** "louislam/uptime-kuma" -> "uptime-kuma": a valid service name (DNS-safe, 40 characters). */
export function defaultServiceName(repository: string): string {
  const last = repository.split("/").pop() ?? "";
  const name = last
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return name || "app";
}

/** Ports web apps usually serve on, best first. */
const webPorts = [80, 8080, 3000, 8000, 5000, 8081, 8888, 9000, 3001, 5678, 8090, 1880, 8443, 443];

/** Ports that are almost never a web page: SSH, mail, DNS, databases, queues. */
const nonWebPorts = new Set([21, 22, 25, 53, 110, 143, 465, 587, 993, 995, 1433, 1521, 3306, 5432, 5672, 6379, 9042, 11211, 27017, 1883]);

/** The TCP ports a person can pick, and the one to start with. */
export function portChoices(config: Pick<ImageConfig, "ports">, preset?: number): { ports: number[]; main: number | null } {
  const ports = [...new Set([...(preset ? [preset] : []), ...config.ports.filter((p) => p.protocol === "tcp").map((p) => p.port)])].sort(
    (a, b) => a - b,
  );
  if (preset) return { ports, main: preset };
  const web = webPorts.find((p) => ports.includes(p));
  return { ports, main: web ?? ports.find((p) => !nonWebPorts.has(p)) ?? ports[0] ?? null };
}

/** The image's VOLUME paths and the preset ones, each once. */
export function volumePaths(config: Pick<ImageConfig, "volumes">, preset: readonly string[] = []): string[] {
  return [...new Set([...config.volumes, ...preset])];
}

/** Whether a port should be public by default (a domain or IP:port): web-ish ports yes, databases and SSH no. */
export function publicByDefault(port: number | null): boolean {
  return port !== null && !nonWebPorts.has(port);
}

/** Variables every image sets for itself (paths, versions, checksums): not settings for people. */
const noiseNames = new Set([
  "PATH",
  "HOME",
  "HOSTNAME",
  "TERM",
  "SHLVL",
  "PWD",
  "USER",
  "LANG",
  "LANGUAGE",
  "GPG_KEY",
  "GPG_KEYS",
  "PKG_RELEASE",
  "DYNPKG_RELEASE",
  "JAVA_HOME",
  "GOPATH",
  "GOROOT",
  "LD_LIBRARY_PATH",
  "DEBIAN_FRONTEND",
  "PYTHONDONTWRITEBYTECODE",
  "PYTHONUNBUFFERED",
  "PYTHONIOENCODING",
  "container",
]);
const noisePatterns = [/^LC_/, /_VERSION$/, /_SHA(1|256|512)?$/, /_CHECKSUM$/, /^PIP_/, /^NPM_CONFIG_/, /^S6_/];

export function isNoiseEnv(name: string): boolean {
  return noiseNames.has(name) || noisePatterns.some((re) => re.test(name));
}

/**
 * .env text from the image's ENV: settings with their defaults first, then
 * secret-looking names with no value for the person to fill in (an image's
 * default password is not one to keep), under `secretsNote` as a comment.
 * `preset` values (a popular image's) come first and win over the image's.
 */
export function prefillEnv(env: ImageConfig["env"], secretsNote: string, preset: Record<string, string> = {}): string {
  const seen = new Set<string>(Object.keys(preset));
  const plain: { key: string; value: string }[] = Object.entries(preset).map(([key, value]) => ({ key, value }));
  const secrets: { key: string; value: string }[] = [];
  for (const { name, value } of env) {
    if (seen.has(name) || isNoiseEnv(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    seen.add(name);
    if (isSecretName(name)) secrets.push({ key: name, value: "" });
    else plain.push({ key: name, value });
  }
  const parts = [stringifyEnv(plain)];
  if (secrets.length > 0) parts.push(`# ${secretsNote}\n${stringifyEnv(secrets)}`);
  return parts.filter((p) => p !== "").join(plain.length > 0 ? "\n" : "");
}

/** The image's command line as one string for display: entrypoint then cmd. */
export function commandLine(config: Pick<ImageConfig, "entrypoint" | "cmd">): string {
  return [...config.entrypoint, ...config.cmd].map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

/** "linux/arm64/v8" -> "arm64". */
export function archOf(platform: string): string {
  return platform.split("/")[1] ?? "";
}

/** 393711408 -> "393M", 1200 -> "1.2K". */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  const [value, unit] = n >= 1e9 ? [n / 1e9, "B"] : n >= 1e6 ? [n / 1e6, "M"] : [n / 1e3, "K"];
  return `${value >= 10 ? Math.floor(value) : Math.floor(value * 10) / 10}${unit}`;
}

/** Splits a typed command into arguments: spaces separate, quotes group. */
export function splitCommand(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g))
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3] ?? ""));
  return out;
}
