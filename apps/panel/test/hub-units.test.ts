// Small pure pieces of the agent hub: version policy, the delimited
// message decoder and stream tickets.

import { describe, expect, test } from "bun:test";
import { Channel, DelimitedDecoder, encodeDelimited, ProtocolViolation } from "../src/agent-hub/channel";
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

  test("any chunking gives the same messages, empty ones and multi-byte prefixes included", () => {
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const messages = [0, 1, 127, 128, 300, 16_384, 70_000, 3].map((n, i) => new Uint8Array(n).map((_, k) => (k + i) & 0xff));
    const wire = new Uint8Array(messages.reduce((sum, m) => sum + encodeDelimited(m).length, 0));
    let at = 0;
    for (const m of messages) {
      const e = encodeDelimited(m);
      wire.set(e, at);
      at += e.length;
    }
    for (let round = 0; round < 20; round++) {
      const decoder = new DelimitedDecoder();
      const out: Uint8Array[] = [];
      for (let offset = 0; offset < wire.length; ) {
        const size = round === 0 ? 1 : 1 + next(round * 50);
        out.push(...decoder.push(wire.subarray(offset, offset + size)));
        offset += size;
      }
      expect(out).toEqual(messages);
      expect(decoder.pending).toBe(false);
    }
    const partial = new DelimitedDecoder();
    expect(partial.push(encodeDelimited(new Uint8Array(200)).subarray(0, 1))).toEqual([]);
    expect(partial.pending).toBe(true);
  });

  test("a 1 MiB message in 1-byte frames decodes in linear time (it took about 34 s)", () => {
    const wire = encodeDelimited(new Uint8Array(1 << 20).fill(9));
    const decoder = new DelimitedDecoder();
    const started = performance.now();
    let out: Uint8Array[] = [];
    for (let i = 0; i < wire.length; i++) out = out.concat(decoder.push(wire.subarray(i, i + 1)));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(out).toHaveLength(1);
    expect(out[0]?.length).toBe(1 << 20);
  });

  test("a bad or oversized length prefix is a protocol violation", () => {
    expect(() => new DelimitedDecoder().push(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]))).toThrow(ProtocolViolation);
    expect(new DelimitedDecoder().push(new Uint8Array([0x80, 0x80]))).toEqual([]);
    const tooLarge = new Uint8Array([0x80, 0x80, 0x80, 0x10]); // 2^31
    expect(() => new DelimitedDecoder().push(tooLarge)).toThrow("stream message too large");
  });
});

describe("Channel", () => {
  test("many tiny frames: reads and the buffered count stay cheap and exact", async () => {
    const grants: number[] = [];
    const channel = new Channel(1, 256 << 10, { data() {}, window: (_s, n) => grants.push(n) });
    const started = performance.now();
    for (let i = 0; i < 200_000; i++) channel.receive(new Uint8Array([i & 0xff]));
    expect(channel.buffered).toBe(200_000);
    // However many frames brought them, a read returns what is buffered.
    let read = 0;
    let reads = 0;
    while (read < 200_000) {
      read += (await channel.read())?.length ?? 0;
      reads++;
    }
    expect(read).toBe(200_000);
    expect(reads).toBe(1);
    expect(channel.buffered).toBe(0);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(grants.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
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
