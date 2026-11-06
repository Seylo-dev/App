// Small pure pieces of the agent hub: version policy, the delimited
// message decoder and stream tickets.

import { describe, expect, test } from "bun:test";
import { DelimitedDecoder, encodeDelimited } from "../src/agent-hub/channel";
import { createTicketStore } from "../src/agent-hub/relay";
import { agentVersionAllowed, isNewer, minimumAgentVersion, parseVersion } from "../src/agent-hub/version";
import { createUser, grant, testPanel } from "./helpers";
import { seedProject, seedService } from "./hub-helpers";

describe("version policy", () => {
  test("parses releases and orders pre-releases first", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: "" });
    expect(parseVersion("dev (commit none)")).toBeNull();
    expect(parseVersion("0.1.0 (commit e2e, built unknown)")).toEqual({ major: 0, minor: 1, patch: 0, pre: "" });
    expect(isNewer("1.2.3", "1.2.3-rc.2")).toBe(true);
    expect(isNewer("1.2.3-rc.10", "1.2.3-rc.2")).toBe(true);
    expect(isNewer("1.2.3", "1.10.0")).toBe(false);
  });

  test("the floor is N-2 minor or the manifest's minAgent, whichever is higher", () => {
    expect(minimumAgentVersion("1.5.2", null)).toBe("1.3.0");
    expect(minimumAgentVersion("1.5.2", "1.4.1")).toBe("1.4.1");
    expect(minimumAgentVersion("dev", null)).toBeNull();
    expect(agentVersionAllowed("1.2.9", "1.3.0")).toBe(false);
    expect(agentVersionAllowed("1.3.0-rc.1", "1.3.0")).toBe(true);
    expect(agentVersionAllowed("dev", "1.3.0")).toBe(true);
  });
});

describe("DelimitedDecoder", () => {
  test("messages split across chunks come out whole", () => {
    const a = new Uint8Array(300).fill(1);
    const b = new Uint8Array(5).fill(2);
    const wire = new Uint8Array([...encodeDelimited(a), ...encodeDelimited(b)]);
    const decoder = new DelimitedDecoder();
    const out = [...decoder.push(wire.subarray(0, 1)), ...decoder.push(wire.subarray(1, 200)), ...decoder.push(wire.subarray(200))];
    expect(out.map((m) => m.length)).toEqual([300, 5]);
    expect(decoder.pending).toBe(false);
  });
});

describe("stream tickets", () => {
  test("single use, one minute, and re-checked against current grants", async () => {
    const panel = testPanel();
    try {
      let now = 1_000_000;
      const store = createTicketStore(() => now);
      const member = await createUser(panel, "member");
      const project = seedProject(panel);
      const nodeId = panel.deps.db
        .insert((await import("../src/db/schema")).nodes)
        .values({ name: "n", publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) })
        .returning()
        .get().id;
      const svc = seedService(panel, project.id, nodeId);
      const principal = { type: "session" as const, user: { ...member.user, name: member.user.name }, sessionId: "s" };
      grant(panel, member.user.id, "service", svc.id, ["logs.view"]);

      const first = store.issue({ principal, action: "logs.view", serviceId: svc.id }, { x: 1 });
      expect(store.take(panel.deps.db, first.ticket)?.data).toEqual({ x: 1 });
      expect(store.take(panel.deps.db, first.ticket)).toBeNull();

      const late = store.issue({ principal, action: "logs.view", serviceId: svc.id }, {});
      now += 61_000;
      expect(store.take(panel.deps.db, late.ticket)).toBeNull();

      const revoked = store.issue({ principal, action: "terminals.shell", serviceId: svc.id }, {});
      expect(store.take(panel.deps.db, revoked.ticket)).toBeNull();
    } finally {
      panel.close();
    }
  });
});
