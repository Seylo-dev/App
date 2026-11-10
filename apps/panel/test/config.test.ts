import { expect, test } from "bun:test";
import { dataDir } from "@seylo/brand";
import { githubEndpoints } from "../src/auth/github-device";
import { ConfigError, envPrefix, loadConfig } from "../src/config";

test("defaults suit the panel container", () => {
  const config = loadConfig({}, "/app/apps/panel");
  expect(config).toMatchObject({
    dataDir: `${dataDir}/panel`,
    port: 3000,
    webDist: "/app/apps/web/dist",
    migrationsDir: "/app/apps/panel/drizzle",
    trustProxy: false,
    secureCookies: true,
  });
});

test("reads brand-prefixed variables and rejects bad values", () => {
  const env = (name: string, value: string) => ({ [envPrefix + name]: value });
  expect(loadConfig({ ...env("PORT", "8080"), ...env("TRUST_PROXY", "true") }, "/x")).toMatchObject({ port: 8080, trustProxy: true });
  expect(() => loadConfig(env("PORT", "http"), "/x")).toThrow(ConfigError);
  expect(() => loadConfig(env("TRUST_PROXY", "yes"), "/x")).toThrow(ConfigError);
});

test("public URL, telemetry and geolocation URLs and an own GitHub OAuth client id", () => {
  const env = (name: string, value: string) => ({ [envPrefix + name]: value });
  const defaults = loadConfig({}, "/x");
  expect(defaults).toMatchObject({
    publicUrl: null,
    telemetryUrl: "https://api.seylo.dev/telemetry",
    geoUrl: "https://api.seylo.dev/geo",
  });
  expect(loadConfig(env("GEO_URL", "http://127.0.0.1:4000/geo/"), "/x").geoUrl).toBe("http://127.0.0.1:4000/geo");
  expect(() => loadConfig(env("GEO_URL", "geo"), "/x")).toThrow(ConfigError);
  expect(defaults.githubClientId).toBeUndefined();
  expect(loadConfig({ ...env("PUBLIC_URL", "http://203.0.113.7:3000/"), ...env("GITHUB_CLIENT_ID", "Iv1.abc123") }, "/x")).toMatchObject({
    publicUrl: "http://203.0.113.7:3000",
    githubClientId: "Iv1.abc123",
  });
  expect(() => loadConfig(env("PUBLIC_URL", "ftp://x"), "/x")).toThrow(ConfigError);
  expect(() => loadConfig(env("GITHUB_CLIENT_ID", "a b"), "/x")).toThrow(ConfigError);
});

test("the installer's image and host port", () => {
  const digest = `sha256:${"c".repeat(64)}`;
  expect(loadConfig({}, "/x")).toMatchObject({ image: null, hostPort: null });
  expect(loadConfig({ ...env("IMAGE", `ghcr.io/acme/panel:0.1.0@${digest}`), ...env("HOST_PORT", "8443") }, "/x")).toMatchObject({
    image: `ghcr.io/acme/panel:0.1.0@${digest}`,
    hostPort: 8443,
  });
  expect(() => loadConfig(env("IMAGE", "not an image"), "/x")).toThrow(ConfigError);
  expect(() => loadConfig(env("HOST_PORT", "70000"), "/x")).toThrow(ConfigError);
});

test("an own GitHub OAuth App replaces the brand's client id", () => {
  const config = loadConfig(env("GITHUB_CLIENT_ID", "Iv1.own0000"), "/x");
  expect(githubEndpoints({ db: {} as never, config }).clientId).toBe("Iv1.own0000");
});

test("SEYLO_TELEMETRY=off and DO_NOT_TRACK=1 turn telemetry off on the container", () => {
  expect(loadConfig({}, "/x").telemetryOffBy).toBeNull();
  expect(loadConfig(env("TELEMETRY", "off"), "/x").telemetryOffBy).toBe(`${envPrefix}TELEMETRY`);
  expect(loadConfig(env("TELEMETRY", "0"), "/x").telemetryOffBy).toBe(`${envPrefix}TELEMETRY`);
  expect(loadConfig(env("TELEMETRY", "on"), "/x").telemetryOffBy).toBeNull();
  expect(loadConfig({ DO_NOT_TRACK: "1" }, "/x").telemetryOffBy).toBe("DO_NOT_TRACK");
  expect(loadConfig({ DO_NOT_TRACK: "0" }, "/x").telemetryOffBy).toBeNull();
});

function env(name: string, value: string) {
  return { [envPrefix + name]: value };
}
