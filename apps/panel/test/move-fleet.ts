// A fake fleet for the panel move tests: it wraps the panel's real agent
// hub (desired state, events and connection listeners stay real) and
// answers the move's agent calls (panel_move.proto) with scripts, including
// the raw streams (ExportRegistry, ImportRegistry, ImportPanelData). What
// the panel sent is kept for the assertions: every call in order and the
// bytes of each upload.

import { gunzipSync } from "node:zlib";
import { OpError } from "@seylo/ops";
import { AgentService } from "@seylo/proto";
import { callCancelled, methodCapability, nodeOffline } from "../src/agent-hub/calls";
import type { AgentHub } from "../src/agent-hub/hub";
import type { TestPanel } from "./helpers";

type Answer = (nodeId: string, request: any, extra: { signal?: AbortSignal; bytes?: Buffer }) => unknown;

/** Every capability AgentService defines. */
const everything = new Set(AgentService.methods.map((m) => methodCapability(m.localName as never)));

export class MoveFleet {
  readonly online = new Set<string>();
  /** Capabilities per node; nodes not listed have every one. */
  readonly caps = new Map<string, Set<string>>();
  readonly calls: { nodeId: string; method: string; request: any }[] = [];
  /** Answers by method; unary calls answer {} without one, uploads their byte count. */
  readonly answers = new Map<string, Answer>();
  /** Bytes each upload received, by method. */
  readonly uploads = new Map<string, Buffer>();
  readonly reconnects: string[] = [];
  /** What ExportRegistry streams. */
  registry = Buffer.from("registry-archive-bytes".repeat(100));
  readonly hub: AgentHub;

  constructor(panel: TestPanel) {
    const real = panel.deps.agents;
    const fleet = this;
    const fake = Object.create(real) as AgentHub;
    const capsOf = (nodeId: string) => fleet.caps.get(nodeId) ?? everything;
    Object.assign(fake, {
      isOnline: (nodeId: string) => fleet.online.has(nodeId),
      onlineNodeIds: () => [...fleet.online],
      capabilities: (nodeId: string) => (fleet.online.has(nodeId) ? capsOf(nodeId) : null),
      supports: (nodeId: string, method: string) => fleet.online.has(nodeId) && capsOf(nodeId).has(methodCapability(method as never)),
      reconnect(nodeId: string) {
        fleet.reconnects.push(nodeId);
      },
      async call(nodeId: string, method: string, request: unknown, options: { signal?: AbortSignal } = {}) {
        if (!fleet.online.has(nodeId)) throw nodeOffline(nodeId);
        if (options.signal?.aborted) throw callCancelled(nodeId);
        fleet.calls.push({ nodeId, method, request });
        const answer = fleet.answers.get(method);
        return answer ? await answer(nodeId, request, { signal: options.signal }) : {};
      },
      openRaw(nodeId: string, method: string, request: any, options: { signal?: AbortSignal } = {}) {
        if (!fleet.online.has(nodeId)) throw nodeOffline(nodeId);
        fleet.calls.push({ nodeId, method, request });
        return fleet.raw(nodeId, method, request, options.signal);
      },
    });
    this.hub = fake;
    panel.deps.agents = fake;
  }

  /** The calls of one method, in order. */
  of(method: string): { nodeId: string; method: string; request: any }[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** The methods called, in order, with the node they went to. */
  sequence(): string[] {
    return this.calls.map((call) => call.method);
  }

  private raw(nodeId: string, method: string, request: any, signal?: AbortSignal) {
    if (method === "exportRegistry") {
      const data = this.registry;
      const answer = this.answers.get(method);
      return {
        body: (async function* () {
          for (let i = 0; i < data.length; i += 512) {
            if (signal?.aborted) throw callCancelled(nodeId);
            yield new Uint8Array(data.subarray(i, i + 512));
          }
        })(),
        writer: null,
        response: (async () => (answer ? await answer(nodeId, request, { signal }) : { sizeBytes: BigInt(data.length * 3) }))(),
        cancel() {},
      };
    }
    const chunks: Buffer[] = [];
    let ended!: () => void;
    let failed!: (error: unknown) => void;
    const end = new Promise<void>((resolve, reject) => {
      ended = resolve;
      failed = reject;
    });
    signal?.addEventListener("abort", () => failed(callCancelled(nodeId)), { once: true });
    const response = end.then(async () => {
      const bytes = Buffer.concat(chunks);
      this.uploads.set(method, bytes);
      const answer = this.answers.get(method);
      if (answer) return answer(nodeId, request, { signal, bytes });
      if (method === "importPanelData") return { sizeBytes: BigInt(bytes.length), files: request.manifest.length };
      return { sizeBytes: BigInt(bytes.length) };
    });
    response.catch(() => undefined);
    return {
      body: null,
      writer: {
        async write(chunk: Uint8Array) {
          if (signal?.aborted) throw callCancelled(nodeId);
          chunks.push(Buffer.from(chunk));
        },
        end: () => ended(),
      },
      response,
      cancel: () => failed(callCancelled(nodeId)),
    };
  }
}

/** A call that waits until `release()` (or rejects once its signal aborts). */
export function held<T>(value: T): { answer: Answer; release: () => void; started: Promise<void> } {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  return {
    answer: async (nodeId, _request, { signal }) => {
      started();
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve);
        signal?.addEventListener("abort", () => reject(callCancelled(nodeId)), { once: true });
      });
      return value;
    },
    release,
    started: begun,
  };
}

/** An agent's refusal as the hub turns it into an OpError. */
export function agentRefusal(code: "UNAVAILABLE" | "CONFLICT" | "BAD_REQUEST", message: string): OpError {
  return new OpError(code, message, { reason: "agent" });
}

/** The files of a .tar.gz, by path (regular files only). */
export function untar(gz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(gz);
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (from: number, length: number) =>
      header
        .subarray(from, from + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const name = text(0, 100);
    const prefix = text(345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    let size = 0;
    if ((header[124] as number) & 0x80) {
      for (let i = 125; i < 136; i++) size = size * 256 + (header[i] as number);
    } else size = Number.parseInt(text(124, 12).trim() || "0", 8);
    const type = text(156, 1);
    offset += 512;
    if (type === "0" || type === "") files.set(path, Buffer.from(tar.subarray(offset, offset + size)));
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}
