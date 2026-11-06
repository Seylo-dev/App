import { describe, expect, test } from "bun:test";
import { popularImages } from "./popular";
import {
  archOf,
  commandLine,
  defaultServiceName,
  formatCount,
  hasNextPage,
  isNoiseEnv,
  portChoices,
  prefillEnv,
  publicByDefault,
  splitCommand,
  volumePaths,
} from "./prefill";

const tcp = (port: number) => ({ port, protocol: "tcp" as const });

describe("service name", () => {
  test("the repository's last part, DNS-safe", () => {
    expect(defaultServiceName("louislam/uptime-kuma")).toBe("uptime-kuma");
    expect(defaultServiceName("nginx")).toBe("nginx");
    expect(defaultServiceName("acme/My_App.v2")).toBe("my-app-v2");
    expect(defaultServiceName("x/".concat("a".repeat(60)))).toHaveLength(40);
    expect(defaultServiceName("acme/__")).toBe("app");
  });
});

describe("main port", () => {
  test("a web port wins over SSH; UDP never counts", () => {
    expect(portChoices({ ports: [tcp(22), tcp(3000)] })).toEqual({ ports: [22, 3000], main: 3000 });
    expect(portChoices({ ports: [tcp(5432)] }).main).toBe(5432);
    expect(portChoices({ ports: [{ port: 53, protocol: "udp" }] })).toEqual({ ports: [], main: null });
    expect(portChoices({ ports: [tcp(1025), tcp(8025), tcp(1110)] }).main).toBe(1025);
  });

  test("a preset port is offered and chosen even when the image does not EXPOSE it", () => {
    expect(portChoices({ ports: [tcp(9000)] }, 9001)).toEqual({ ports: [9000, 9001], main: 9001 });
  });

  test("databases and SSH stay internal by default", () => {
    expect(publicByDefault(3000)).toBe(true);
    expect(publicByDefault(5432)).toBe(false);
    expect(publicByDefault(22)).toBe(false);
    expect(publicByDefault(null)).toBe(false);
  });
});

describe("env prefill", () => {
  test("build noise goes, settings keep their defaults, secrets are left empty under a note", () => {
    const env = prefillEnv(
      [
        { name: "PATH", value: "/usr/bin" },
        { name: "NODE_VERSION", value: "22.1.0" },
        { name: "LC_ALL", value: "C.UTF-8" },
        { name: "GITEA_CUSTOM", value: "/data/gitea" },
        { name: "APP_TITLE", value: "My app here" },
        { name: "SECRET_KEY", value: "changeme" },
        { name: "DB_PASSWORD", value: "" },
        { name: "GITEA_CUSTOM", value: "/again" },
      ],
      "Fill these in.",
    );
    expect(env).toBe('GITEA_CUSTOM=/data/gitea\nAPP_TITLE="My app here"\n\n# Fill these in.\nSECRET_KEY=\nDB_PASSWORD=\n');
  });

  test("preset values lead and win over the image's", () => {
    const env = prefillEnv(
      [
        { name: "MB_DB_FILE", value: "/tmp/x" },
        { name: "MB_JETTY_PORT", value: "3000" },
      ],
      "x",
      { MB_DB_FILE: "/metabase-data/metabase.db" },
    );
    expect(env).toBe("MB_DB_FILE=/metabase-data/metabase.db\nMB_JETTY_PORT=3000\n");
  });

  test("preset volumes join the image's VOLUME paths once", () => {
    expect(volumePaths({ volumes: ["/data"] }, ["/data", "/app/data"])).toEqual(["/data", "/app/data"]);
    expect(volumePaths({ volumes: [] })).toEqual([]);
  });

  test("nothing but noise is an empty file", () => {
    expect(prefillEnv([{ name: "PATH", value: "/bin" }], "x")).toBe("");
    expect(prefillEnv([{ name: "API_TOKEN", value: "" }], "x")).toBe("# x\nAPI_TOKEN=\n");
  });

  test("noise names", () => {
    for (const name of ["PATH", "HOME", "GOSU_VERSION", "NGINX_SHA256", "PIP_NO_CACHE_DIR", "S6_KEEP_ENV", "LANG"])
      expect(isNoiseEnv(name)).toBe(true);
    for (const name of ["TZ", "N8N_HOST", "GF_PATHS_DATA", "VERSION_CHECK"]) expect(isNoiseEnv(name)).toBe(false);
  });
});

describe("display helpers", () => {
  test("command line, arch, counts", () => {
    expect(commandLine({ entrypoint: ["/usr/bin/dumb-init", "--"], cmd: ["node", "server.js"] })).toBe(
      "/usr/bin/dumb-init -- node server.js",
    );
    expect(commandLine({ entrypoint: [], cmd: ["sh", "-c", "echo hi"] })).toBe('sh -c "echo hi"');
    expect(archOf("linux/arm64/v8")).toBe("arm64");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1200)).toBe("1.2K");
    expect(formatCount(393_711_408)).toBe("393M");
    expect(formatCount(13_560_944_144)).toBe("13B");
  });

  test("typed commands split like a shell would, quotes kept together", () => {
    expect(splitCommand('server /data --console-address ":9001"')).toEqual(["server", "/data", "--console-address", ":9001"]);
    expect(splitCommand("  sh -c 'echo hi there'  ")).toEqual(["sh", "-c", "echo hi there"]);
    expect(splitCommand("")).toEqual([]);
  });

  test("Show more stops at the last page dockerHub.search serves", () => {
    expect(hasNextPage(1, true)).toBe(true);
    expect(hasNextPage(19, true)).toBe(true);
    // Page 21 would be refused, however many results Docker Hub still has.
    expect(hasNextPage(20, true)).toBe(false);
    expect(hasNextPage(3, false)).toBe(false);
  });
});

describe("popular images", () => {
  test("ids are unique and every repository is a Docker Hub one", () => {
    expect(new Set(popularImages.map((p) => p.id)).size).toBe(popularImages.length);
    for (const image of popularImages) expect(image.repository).toMatch(/^(?:[a-z0-9]+(?:[_-][a-z0-9]+)*\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
    expect(popularImages.map((p) => p.repository)).toEqual(
      expect.arrayContaining(["nginx", "louislam/uptime-kuma", "gitea/gitea", "rustfs/rustfs"]),
    );
    for (const image of popularImages) for (const path of image.volumes ?? []) expect(path).toMatch(/^\/[^\s]+$/);
  });
});
