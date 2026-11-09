import { expect, test } from "bun:test";
import { dockerHubRef } from "./image-port";

test("Docker Hub images give their repository and tag, latest when none is named", () => {
  expect(dockerHubRef("nginx:1.27")).toEqual({ repository: "nginx", tag: "1.27" });
  expect(dockerHubRef(" nginx ")).toEqual({ repository: "nginx", tag: "latest" });
  expect(dockerHubRef("louislam/uptime-kuma:2")).toEqual({ repository: "louislam/uptime-kuma", tag: "2" });
  expect(dockerHubRef("docker.io/library/redis:7.4-alpine")).toEqual({ repository: "redis", tag: "7.4-alpine" });
});

test("other registries, digests and what Docker Hub would refuse give nothing", () => {
  expect(dockerHubRef("")).toBeNull();
  expect(dockerHubRef("ghcr.io/acme/api:1.4")).toBeNull();
  expect(dockerHubRef("localhost:5000/app")).toBeNull();
  expect(dockerHubRef("nginx@sha256:abc")).toBeNull();
  expect(dockerHubRef("Nginx:1")).toBeNull();
  expect(dockerHubRef("nginx:1 2")).toBeNull();
});
