// known_hosts lines handed in for a credential must name its host the way
// clones look it up ("[host]:port" off port 22). Before, the panel stored
// any lines, so an API or MCP client could save a credential whose every
// clone failed with "No known host key" (found in the 0.2.2 credentials UI
// review: only the web form checked the format).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { git } from "@seylo/ops";
import { checkKnownHostsFor } from "../src/modules/git/remote";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

describe("checkKnownHostsFor", () => {
  test("empty lines use the built-in keys", () => {
    expect(() => checkKnownHostsFor("github.com", "")).not.toThrow();
    expect(() => checkKnownHostsFor("github.com", null)).not.toThrow();
  });
  test("a line for the host passes, also on another port in brackets", () => {
    expect(() => checkKnownHostsFor("git.example.com", `git.example.com ${key}`)).not.toThrow();
    expect(() => checkKnownHostsFor("gitea.lan:2222", `[gitea.lan]:2222 ${key}`)).not.toThrow();
    expect(() => checkKnownHostsFor("Gitea.LAN:2222", `# scanned\n[gitea.lan]:2222,10.0.0.5 ${key}`)).not.toThrow();
  });
  test("lines for another name or in the wrong form are refused", () => {
    expect(() => checkKnownHostsFor("gitea.lan:2222", `gitea.lan:2222 ${key}`)).toThrow(/\[gitea\.lan\]:2222/);
    expect(() => checkKnownHostsFor("gitea.lan:2222", `gitea.lan ${key}`)).toThrow(/None of these lines/);
    expect(() => checkKnownHostsFor("git.example.com", `other.example.com ${key}`)).toThrow(/None of these lines/);
  });
  test("hashed lines are refused with how to get plain ones", () => {
    expect(() => checkKnownHostsFor("gitea.lan:2222", `|1|abc=|def= ${key}`)).toThrow(/ssh-keyscan -p 2222 gitea\.lan/);
  });
});

describe("the credential ops check the lines", () => {
  let panel: TestPanel;
  let cookie: string;
  beforeEach(async () => {
    panel = testPanel();
    ({ cookie } = await createUser(panel, "owner"));
  });
  afterEach(() => panel.close());

  test("generateSshKey and updateCredential refuse lines that match nothing", async () => {
    const bad = await callOp(
      panel,
      git.generateSshKey,
      { name: "k", host: "gitea.lan:2222", knownHosts: `gitea.lan:2222 ${key}` },
      { cookie },
    );
    expect(bad.status).toBe(400);
    const good = await callOp(
      panel,
      git.generateSshKey,
      { name: "k", host: "gitea.lan:2222", knownHosts: `[gitea.lan]:2222 ${key}` },
      { cookie },
    );
    expect(good.status).toBe(200);
    const update = await callOp(panel, git.updateCredential, { credentialId: good.body.id, knownHosts: `|1|x=|y= ${key}` }, { cookie });
    expect(update.status).toBe(400);
  });
});
