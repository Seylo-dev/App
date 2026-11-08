// Join commands take the installer from the install host, which checks it
// against the signed manifest, never from a plain release asset; a released
// panel adds --version so the node gets the agent of the panel's version
// (the installer then reads that release's signed manifest).

import { expect, test } from "bun:test";
import { githubOrg, githubRepo, installUrl } from "@seylo/brand";
import { installerSource, joinCommand } from "../src/modules/nodes/join-command";

const host = `https://${installUrl}`;

test("a released panel version pins its own release through --version on the install host", () => {
  expect(installerSource("0.2.0-rc.2")).toEqual({ url: host, version: "0.2.0-rc.2" });
  expect(installerSource("0.2.0")).toEqual({ url: host, version: "0.2.0" });
  expect(installerSource("v1.4.2")).toEqual({ url: host, version: "1.4.2" });
});

test("builds without a release install the latest stable release", () => {
  for (const v of ["dev", "", "0.2.0-SNAPSHOT-abc1234", "0.2.0-rc.1-5-gabc1234", "0.2.0+meta", "0.2.0-dirty", "0.2"]) {
    expect({ v, source: installerSource(v) }).toEqual({ v, source: { url: host, version: null } });
  }
});

test("the command pipes the install host into sh with the join flags, never a release asset", () => {
  expect(joinCommand("0.2.0-rc.2", "https://203.0.113.9:3443", "tok", "sha256:ab")).toBe(
    `curl -fsSL ${host} | sudo sh -s -- join --panel 'https://203.0.113.9:3443' --token 'tok' --version '0.2.0-rc.2' --pin 'sha256:ab'`,
  );
  expect(joinCommand("dev", "http://203.0.113.9:3000", "tok", null, true)).toBe(
    `curl -fsSL ${host} | sudo sh -s -- join --panel 'http://203.0.113.9:3000' --token 'tok' --insecure`,
  );
  for (const v of ["0.2.0-rc.2", "0.2.0", "dev"]) {
    expect(joinCommand(v, "https://p", "t")).not.toContain("github.com");
    expect(joinCommand(v, "https://p", "t")).not.toContain(`${githubOrg}/${githubRepo}`);
  }
});
