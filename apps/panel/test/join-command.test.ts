// Join commands install the panel's own release: the installer of that
// release (which defaults to its own version) instead of the install host's
// latest stable one, so a node joining a pre-release or an older panel gets
// the agent of the panel's version.

import { expect, test } from "bun:test";
import { githubOrg, githubRepo, installUrl } from "@seylo/brand";
import { installerSource, joinCommand } from "../src/modules/nodes/join-command";

const releaseInstaller = (v: string) => `https://github.com/${githubOrg}/${githubRepo}/releases/download/v${v}/install.sh`;

test("a released panel version pins its own release's installer", () => {
  expect(installerSource("0.2.0-rc.2")).toEqual({ url: releaseInstaller("0.2.0-rc.2"), version: "0.2.0-rc.2" });
  expect(installerSource("0.2.0")).toEqual({ url: releaseInstaller("0.2.0"), version: "0.2.0" });
  expect(installerSource("v1.4.2")).toEqual({ url: releaseInstaller("1.4.2"), version: "1.4.2" });
});

test("builds without a release fall back to the install host", () => {
  for (const v of ["dev", "", "0.2.0-SNAPSHOT-abc1234", "0.2.0-rc.1-5-gabc1234", "0.2.0+meta", "0.2.0-dirty", "0.2"]) {
    expect({ v, source: installerSource(v) }).toEqual({ v, source: { url: `https://${installUrl}`, version: null } });
  }
});

test("the command pipes the pinned installer into sh with the join flags", () => {
  expect(joinCommand("0.2.0-rc.2", "https://203.0.113.9:3443", "tok", "sha256:ab")).toBe(
    `curl -fsSL ${releaseInstaller("0.2.0-rc.2")} | sudo sh -s -- join --panel 'https://203.0.113.9:3443' --token 'tok' --pin 'sha256:ab'`,
  );
  expect(joinCommand("dev", "http://203.0.113.9:3000", "tok", null, true)).toBe(
    `curl -fsSL https://${installUrl} | sudo sh -s -- join --panel 'http://203.0.113.9:3000' --token 'tok' --insecure`,
  );
});
