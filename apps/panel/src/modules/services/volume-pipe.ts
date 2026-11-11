// Volume data through the panel. Nodes share no network, so every copy of
// a volume goes node -> panel -> node: readVolume opens ExportVolume on the
// node that holds it, pipeIntoVolume feeds bytes into ImportVolume on the
// node that gets it. A move or a clone pipes one into the other
// (move.ts relayVolume); a service export writes readVolume's stream into
// its .zip, and an import pipes the parts someone uploads (a ChunkFeed)
// into pipeIntoVolume with the limits of data from outside.
//
// Pipes that run are listed per panel by the service they write into, so
// deleting that service stops them first (services/delete.ts).

import type { RawAgentStream } from "../../agent-hub/calls";
import type { Deps } from "../../deps";

type ImportRequest = { maxBytes?: number; maxEntries?: number; sha256?: string };

/**
 * Agents with this honour ImportVolume's max_bytes, max_entries and sha256
 * (go/internal/volumes ImportLimitsCapability). Data from an uploaded file
 * only goes to them: an older agent would ignore the limits.
 */
export const importLimitsCapability = "volume.import-limits.v1";

interface OpenPipe {
  serviceId: string;
  kind: string;
  cancel(reason: string): void;
}

const pipes = new WeakMap<object, Set<OpenPipe>>();

function openOn(db: object): Set<OpenPipe> {
  let set = pipes.get(db);
  if (!set) {
    set = new Set();
    pipes.set(db, set);
  }
  return set;
}

/** ExportVolume of `serviceId`'s volume on `nodeId`: the .tar.gz as it is read, and its counts once it ends. */
export function readVolume(
  deps: Pick<Deps, "agents">,
  input: { nodeId: string; serviceId: string; volume: string },
): RawAgentStream<"exportVolume"> {
  return deps.agents.openRaw(input.nodeId, "exportVolume", { serviceId: input.serviceId, volume: input.volume });
}

/**
 * Sends `chunks` into ImportVolume of `serviceId`'s volume on `nodeId`
 * (replacing what is there) and returns the bytes sent and the file bytes
 * the node wrote. A failure on either side cancels the node's stream and
 * throws; so does `signal`, at once, even while a write waits for the
 * node. `kind` names the pipe for pipesRunning.
 */
export async function pipeIntoVolume(
  deps: Pick<Deps, "agents" | "db">,
  input: {
    nodeId: string;
    serviceId: string;
    volume: string;
    chunks: AsyncIterable<Uint8Array>;
    sizeBytes?: number;
    limits?: ImportRequest;
    kind?: string;
    signal?: AbortSignal;
  },
): Promise<{ sent: number; written: number }> {
  const imported = deps.agents.openRaw(input.nodeId, "importVolume", {
    serviceId: input.serviceId,
    volume: input.volume,
    replace: true,
    sizeBytes: BigInt(input.sizeBytes ?? 0),
    maxBytes: BigInt(input.limits?.maxBytes ?? 0),
    maxEntries: BigInt(input.limits?.maxEntries ?? 0),
    sha256: input.limits?.sha256 ?? "",
  });
  const pipe: OpenPipe = { serviceId: input.serviceId, kind: input.kind ?? "copy", cancel: (reason) => imported.cancel(reason) };
  const open = openOn(deps.db);
  open.add(pipe);
  const stop = () => imported.cancel(String(input.signal?.reason ?? "the copy was stopped"));
  if (input.signal?.aborted) stop();
  else input.signal?.addEventListener("abort", stop, { once: true });
  const chunks = input.chunks[Symbol.asyncIterator]();
  // The node may end the stream first (no space, a limit, a cancel): stop waiting for bytes then.
  const refused = imported.response.then(
    () => new Promise<never>(() => undefined),
    (error: unknown) => {
      throw error;
    },
  );
  refused.catch(() => undefined);
  let sent = 0;
  try {
    for (;;) {
      const next = await Promise.race([chunks.next(), refused]);
      if (next.done) break;
      await imported.writer.write(next.value);
      sent += next.value.length;
    }
    imported.writer.end();
    const done = await imported.response;
    return { sent, written: Number(done.sizeBytes) };
  } catch (error) {
    imported.cancel("the copy failed");
    void chunks.return?.()?.catch(() => undefined);
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", stop);
    open.delete(pipe);
  }
}

/** Stops the pipes that write into these services (they are being deleted). */
export function cancelPipesInto(deps: Pick<Deps, "db">, serviceIds: readonly string[], reason: string): void {
  for (const pipe of openOn(deps.db)) if (serviceIds.includes(pipe.serviceId)) pipe.cancel(reason);
}

/** How many pipes of `kind` run now on this panel. */
export function pipesRunning(deps: Pick<Deps, "db">, kind: string): number {
  let n = 0;
  for (const pipe of openOn(deps.db)) if (pipe.kind === kind) n++;
  return n;
}

/**
 * Bytes handed over one request at a time and read as one stream: push()
 * resolves once the reader took the chunk, so a slow node slows the sender
 * instead of filling memory. end() finishes the stream, fail() breaks it
 * (the reader throws, and pending pushes reject).
 */
export class ChunkFeed implements AsyncIterable<Uint8Array> {
  private slot: { chunk: Uint8Array; taken: () => void } | null = null;
  private wake: (() => void) | null = null;
  private ended = false;
  private broken: unknown = null;
  private rejects = new Set<(error: unknown) => void>();

  push(chunk: Uint8Array): Promise<void> {
    if (this.broken) return Promise.reject(this.broken);
    if (this.ended || this.slot) return Promise.reject(new Error("the feed takes one chunk at a time, before it ends"));
    return new Promise<void>((resolve, reject) => {
      const settle = () => {
        this.rejects.delete(reject);
        resolve();
      };
      this.rejects.add(reject);
      this.slot = { chunk, taken: settle };
      this.wake?.();
    });
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  fail(error: unknown): void {
    if (this.broken) return;
    this.broken = error;
    for (const reject of this.rejects) reject(error);
    this.rejects.clear();
    this.slot = null;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      if (this.broken) throw this.broken;
      const slot = this.slot;
      if (slot) {
        this.slot = null;
        slot.taken();
        yield slot.chunk;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}
