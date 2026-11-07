// A node picks the DATA frame sizes on every stream. Tiny frames must not
// cost an object each while they wait: neither in a Channel nobody reads
// yet nor in a DelimitedDecoder collecting a message. Before, a 1 MiB
// message in 1-byte frames held about 74 MiB of heap (a 16 MiB one about
// 1.2 GiB), and a Channel about as much per MiB of unread frames.

import { expect, test } from "bun:test";
import { Channel, DelimitedDecoder, encodeDelimited } from "../src/agent-hub/channel";

const mib = 1 << 20;

/** Heap growth while the value `fill` built is still alive. */
function heapGrowth<T>(fill: () => T): { grew: number; value: T } {
  Bun.gc(true);
  const before = process.memoryUsage().heapUsed;
  const value = fill();
  Bun.gc(true);
  return { grew: process.memoryUsage().heapUsed - before, value };
}

test("a 1 MiB message pending in 1-byte frames holds about its own size, not an object per frame", () => {
  const body = new Uint8Array(mib).map((_, i) => i & 0xff);
  const wire = encodeDelimited(body);
  const { grew, value: decoder } = heapGrowth(() => {
    const decoder = new DelimitedDecoder();
    // The last byte is withheld, so the whole message stays pending.
    for (let i = 0; i < wire.length - 1; i++) {
      if (decoder.push(wire.subarray(i, i + 1)).length > 0) throw new Error("completed early");
    }
    return decoder;
  });
  expect(decoder.pending).toBe(true);
  // Before: ~74 MiB. Now the body buffer (at most the message) and change.
  expect(grew).toBeLessThan(4 * mib);
  expect(decoder.held).toBeLessThanOrEqual(mib);
  const out = decoder.push(wire.subarray(wire.length - 1));
  expect(out).toHaveLength(1);
  expect(out[0]).toEqual(body);
  expect(decoder.pending).toBe(false);
  expect(decoder.held).toBe(0);
});

test("the decoder's buffer grows with what arrived, not with what the prefix announces", () => {
  const decoder = new DelimitedDecoder();
  // A 16 MiB message announced, 100 KiB of it sent in 1-byte frames.
  const wire = encodeDelimited(new Uint8Array(16 * mib));
  for (let i = 0; i < 3 + 100 * 1024; i++) decoder.push(wire.subarray(i, i + 1));
  expect(decoder.held).toBeLessThanOrEqual(2 * 100 * 1024);
  expect(decoder.held).toBeGreaterThanOrEqual(100 * 1024);
});

test("1 MiB of unread 1-byte frames on a Channel holds about 1 MiB, and one read returns all of it in order", async () => {
  const grants: number[] = [];
  const channel = new Channel(1, mib, { data() {}, window: (_stream, n) => grants.push(n) });
  const { grew } = heapGrowth(() => {
    for (let i = 0; i < mib; i++) channel.receive(new Uint8Array([i & 0xff]));
    return null;
  });
  expect(channel.buffered).toBe(mib);
  // Before: ~100 MiB (a copy object per frame). Now one buffer of at most twice the bytes.
  expect(grew).toBeLessThan(4 * mib);
  const chunk = await channel.read();
  expect(chunk?.length).toBe(mib);
  expect(chunk?.[255]).toBe(255);
  expect(chunk?.[256]).toBe(0);
  expect(channel.buffered).toBe(0);
  expect(grants.reduce((a, b) => a + b, 0)).toBe(mib);
});

test("a 4 MiB message as 1-byte frames through a Channel and the decoder stays linear and small", async () => {
  // The stream path a node drives: frames into the Channel, reads into the decoder.
  const channel = new Channel(1, 256 << 10, { data() {}, window() {} });
  const decoder = new DelimitedDecoder();
  const wire = encodeDelimited(new Uint8Array(4 * mib).fill(7));
  const started = performance.now();
  let messages = 0;
  Bun.gc(true);
  const before = process.memoryUsage().heapUsed;
  let peak = 0;
  for (let i = 0; i < wire.length; i++) {
    channel.receive(wire.subarray(i, i + 1));
    // A slow reader: it drains every 4096 frames.
    if (i % 4096 === 4095 || i === wire.length - 1) {
      while (channel.buffered > 0) {
        const chunk = await channel.read();
        if (chunk) messages += decoder.push(chunk).length;
      }
      if (i % (1 << 20) === (1 << 20) - 1) {
        Bun.gc(true);
        peak = Math.max(peak, process.memoryUsage().heapUsed - before);
      }
    }
  }
  expect(messages).toBe(1);
  expect(performance.now() - started).toBeLessThan(10_000);
  // The 4 MiB body buffer and change; before it was ~74 B per frame (~300 MiB here).
  expect(peak).toBeLessThan(12 * mib);
});
