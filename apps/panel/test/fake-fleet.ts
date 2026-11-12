// A fake fleet for the projects, services and deploys tests. It wraps the
// panel's real agent hub: events, node state and the desired-state queue
// stay real, while calls and streams to agents are answered by scripts.
// Agents' answers are what the protocol promises (BuildProgress final
// stages, DeployProgress, raw byte streams), so the deploy runner is tested
// end to end without a network.

import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { durationFromMs, timestampNow } from "@bufbuild/protobuf/wkt";
import { OpError } from "@seylo/ops";
import {
  BuildProgressSchema,
  BuildSourceInfoSchema,
  BuildStage,
  DeployProgressSchema,
  type DeployStage,
  type Event,
  EventSchema,
  HealthState,
  InstanceState,
  ServicePhase,
  ServiceStatusSchema,
  StateDeltaSchema,
  StateSnapshotSchema,
} from "@seylo/proto";
import type { AgentHub } from "../src/agent-hub/hub";
import { nodes } from "../src/db/schema";
import { engineFor } from "../src/modules/deployments/engine";
import type { TestPanel } from "./helpers";

export interface FakeBuild {
  nodeId: string;
  request: Record<string, unknown> & { buildId: string; serviceId: string; imageReference: string };
}

export type BuildScript = (build: FakeBuild) => {
  logs?: string[];
  result: "succeeded" | "failed" | "hang";
  digest?: string;
  message?: string;
  /** The commit the node says it checked out (BuildSourceInfo, sent for git sources once fetched). */
  sourceInfo?: { commit: string; subject?: string; author?: string };
};

const allCapabilities = new Set([
  "state.sync.v1",
  "build.run.v1",
  "compose.parse.v1",
  "volume.transfer.v1",
  "volume.import-limits.v1",
  "exec.run.v1",
]);

/** How a fake ExportVolume goes: it hangs after its bytes until cancelled, or fails at the end. */
export interface VolumeScript {
  hang?: boolean;
  fail?: OpError;
  /** The file bytes it says it archived (default: the stored bytes' length). */
  unpackedBytes?: number;
}

export class FakeFleet {
  readonly calls: { nodeId: string; method: string; request: unknown }[] = [];
  readonly builds: FakeBuild[] = [];
  readonly online = new Set<string>();
  /** How the next builds end; default: success. */
  buildScript: BuildScript = () => ({ logs: ["#1 building", "#2 done"], result: "succeeded", digest: `sha256:${"a".repeat(64)}` });
  /** Request lines sent to the panel registry through Tunnel. */
  readonly registryRequests: string[] = [];
  /** Ends every open build stream as if the connection dropped. */
  readonly drops: (() => void)[] = [];
  /** Unary answers by method name. */
  answers = new Map<string, (nodeId: string, request: any) => unknown>();
  /** Volume contents per node: `${serviceId}/${volume}` -> bytes. */
  readonly volumes = new Map<string, Map<string, Uint8Array>>();
  /** Capabilities per node, instead of every one. */
  readonly caps = new Map<string, Set<string>>();
  /** Methods a node's agent does not support. */
  readonly unsupported = new Map<string, Set<string>>();
  /** How the next ExportVolume streams go. */
  volumeScript: (nodeId: string, request: { serviceId: string; volume: string }) => VolumeScript = () => ({});
  /** Raw streams the panel cancelled, as `${method} ${serviceId}/${volume}`. */
  readonly cancelled: string[] = [];
  /** How many of the next ImportVolume streams take no bytes: their writes wait until they are cancelled. */
  holdImportWrites = 0;
  /** Called with every chunk an ExportVolume hands out (to look at the panel meanwhile). */
  onExportChunk: ((nodeId: string, key: string) => void) | null = null;
  private seq = new Map<string, bigint>();
  readonly hub: AgentHub;

  constructor(private readonly panel: TestPanel) {
    const real = panel.deps.agents;
    const fleet = this;
    const fake = Object.create(real) as AgentHub;
    Object.assign(fake, {
      isOnline: (nodeId: string) => fleet.online.has(nodeId),
      onlineNodeIds: () => [...fleet.online],
      capabilities: (nodeId: string) => (fleet.online.has(nodeId) ? (fleet.caps.get(nodeId) ?? allCapabilities) : null),
      supports: (nodeId: string, method: string) => fleet.online.has(nodeId) && !fleet.unsupported.get(nodeId)?.has(method),
      async call(nodeId: string, method: string, request: unknown) {
        if (!fleet.online.has(nodeId)) throw new OpError("UNAVAILABLE", "The node is offline.", { reason: "offline", nodeId });
        fleet.calls.push({ nodeId, method, request });
        const answer = fleet.answers.get(method);
        if (answer) return answer(nodeId, request);
        return {};
      },
      open(nodeId: string, method: string, request: any) {
        if (!fleet.online.has(nodeId)) throw new OpError("UNAVAILABLE", "The node is offline.", { reason: "offline", nodeId });
        fleet.calls.push({ nodeId, method, request });
        if (method !== "build") throw new OpError("NOT_IMPLEMENTED", `fake agent has no stream ${method}`);
        return fleet.buildStream({ nodeId, request });
      },
      openRaw(nodeId: string, method: string, request: any) {
        if (!fleet.online.has(nodeId)) throw new OpError("UNAVAILABLE", "The node is offline.", { reason: "offline", nodeId });
        fleet.calls.push({ nodeId, method, request });
        return fleet.rawStream(nodeId, method, request);
      },
    });
    this.hub = fake;
    panel.deps.agents = fake;
  }

  /** Adds a node row (and marks it online). */
  addNode(name: string, options: { canBuild?: boolean; online?: boolean; panelNode?: boolean } = {}): string {
    const row = this.panel.deps.db
      .insert(nodes)
      .values({
        name,
        publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
        canBuild: options.canBuild ?? false,
        isPanelNode: options.panelNode ?? false,
      })
      .returning()
      .get();
    if (options.online ?? true) this.online.add(row.id);
    return row.id;
  }

  private buildStream(build: FakeBuild) {
    this.builds.push(build);
    const script = this.buildScript(build);
    const progress = (stage: BuildStage, extra: Record<string, unknown> = {}) =>
      ({ output: { case: "progress", value: create(BuildProgressSchema, { buildId: build.request.buildId, stage, ...extra }) } }) as const;
    const messages: unknown[] = [progress(BuildStage.FETCHING_SOURCE)];
    if (script.sourceInfo) {
      messages.push({
        output: {
          case: "sourceInfo",
          value: create(BuildSourceInfoSchema, { subject: "", author: "", ...script.sourceInfo }),
        },
      });
    }
    messages.push(progress(BuildStage.BUILDING));
    for (const line of script.logs ?? []) messages.push({ output: { case: "log", value: new TextEncoder().encode(`${line}\n`) } });
    let hang: (() => void) | null = null;
    if (script.result === "succeeded") {
      messages.push(progress(BuildStage.PUSHING));
      messages.push(progress(BuildStage.SUCCEEDED, { imageDigest: script.digest ?? "", duration: durationFromMs(4000) }));
    } else if (script.result === "failed") {
      messages.push(progress(BuildStage.FAILED, { message: script.message ?? "exit code 1" }));
    }
    let cancelled = false;
    let dropped = false;
    this.drops.push(() => {
      dropped = true;
      cancelled = true;
      (hang as (() => void) | null)?.();
    });
    let resolveDone!: () => void;
    let rejectDone!: (e: unknown) => void;
    const done = new Promise<{ message: string }>((res, rej) => {
      resolveDone = () => res({ message: "" });
      rejectDone = rej;
    });
    done.catch(() => undefined);
    const iterator = async function* () {
      for (const m of messages) {
        if (cancelled) break;
        await Bun.sleep(0);
        yield m;
      }
      if (script.result === "hang" && !cancelled) await new Promise<void>((res) => (hang = res));
      if (cancelled) {
        const error = dropped
          ? new OpError("UNAVAILABLE", "The node is offline.", { reason: "offline" })
          : new OpError("UNAVAILABLE", "The request was cancelled.", { reason: "cancelled" });
        rejectDone(error);
        throw error;
      }
      resolveDone();
    };
    return {
      [Symbol.asyncIterator]: iterator,
      done,
      cancel() {
        cancelled = true;
        (hang as (() => void) | null)?.();
      },
    };
  }

  private rawStream(nodeId: string, method: string, request: any) {
    const store = this.volumes.get(nodeId) ?? new Map<string, Uint8Array>();
    this.volumes.set(nodeId, store);
    const key = `${request.serviceId}/${request.volume}`;
    const fleet = this;
    if (method === "exportVolume") {
      const data = store.get(key) ?? new Uint8Array();
      const script = this.volumeScript(nodeId, request);
      const step = data.length > 4096 ? 16384 : 4;
      let cancelled: OpError | null = null;
      let wake: (() => void) | null = null;
      let settle!: { ok: (v: unknown) => void; fail: (e: unknown) => void };
      const response = new Promise((ok, fail) => (settle = { ok, fail }));
      response.catch(() => undefined);
      return {
        body: (async function* () {
          for (let i = 0; i < data.length; i += step) {
            if (cancelled) throw cancelled;
            fleet.onExportChunk?.(nodeId, key);
            await Bun.sleep(0);
            yield data.slice(i, i + step);
          }
          if (script.hang && !cancelled) await new Promise<void>((res) => (wake = res));
          if (cancelled) throw cancelled;
          if (script.fail) {
            settle.fail(script.fail);
            throw script.fail;
          }
          settle.ok({ sizeBytes: BigInt(script.unpackedBytes ?? data.length), entries: 3n });
        })(),
        writer: null,
        response,
        cancel(reason?: string) {
          if (cancelled) return;
          fleet.cancelled.push(`exportVolume ${key}`);
          cancelled = new OpError("UNAVAILABLE", "The request was cancelled.", { reason: "cancelled", ...(reason ? { why: reason } : {}) });
          settle.fail(cancelled);
          (wake as (() => void) | null)?.();
        },
      };
    }
    if (method === "importVolume" || method === "uploadBuildContext") {
      const chunks: Uint8Array[] = [];
      const hold = method === "importVolume" && fleet.holdImportWrites > 0;
      if (hold) fleet.holdImportWrites--;
      let finish!: () => void;
      let abort!: (e: unknown) => void;
      let cancelled: OpError | null = null;
      const ended = new Promise<void>((res, rej) => {
        finish = res;
        abort = rej;
      });
      const response = ended.then(() => {
        const all = Buffer.concat(chunks);
        // Like the agent: another sha256 fails and leaves the volume empty.
        if (method === "importVolume" && request.sha256) {
          const sum = new Bun.CryptoHasher("sha256").update(all).digest("hex");
          if (sum !== request.sha256) {
            store.delete(key);
            throw new OpError("BAD_REQUEST", "the volume archive does not match its checksum", {
              reason: "agent",
              agentReason: "checksum",
            });
          }
        }
        store.set(method === "importVolume" ? key : `upload/${request.uploadId}`, new Uint8Array(all));
        return { sizeBytes: BigInt(all.length) };
      });
      response.catch(() => undefined);
      return {
        body: null,
        writer: {
          async write(chunk: Uint8Array) {
            if (cancelled) throw cancelled;
            // Like a node that grants no window: the write waits, and fails once the stream ends.
            if (hold) {
              await ended.catch(() => undefined);
              throw cancelled ?? new Error("stream already closed");
            }
            chunks.push(new Uint8Array(chunk));
          },
          end: () => finish(),
        },
        response,
        cancel(reason?: string) {
          if (cancelled) return;
          fleet.cancelled.push(`${method} ${key}`);
          cancelled = new OpError("UNAVAILABLE", "The request was cancelled.", { reason: "cancelled", ...(reason ? { why: reason } : {}) });
          // A cancelled import leaves the volume empty (the agent clears data from a file).
          if (method === "importVolume" && request.sha256) store.delete(key);
          abort(cancelled);
        },
      };
    }
    if (method === "tunnel") {
      let request = "";
      return {
        writer: {
          async write(chunk: Uint8Array) {
            request += new TextDecoder().decode(chunk);
            fleet.registryRequests.push(request.split("\r\n")[0] ?? "");
          },
          end() {},
        },
        body: (async function* () {
          yield new TextEncoder().encode("HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n");
        })(),
        response: Promise.resolve({}),
        cancel() {},
      };
    }
    throw new OpError("NOT_IMPLEMENTED", `fake agent has no raw method ${method}`);
  }

  /** Sends an agent event through the real hub, as the session would. */
  emit(nodeId: string, payload: Event["payload"]): void {
    this.panel.deps.agents.emitEvent(nodeId, create(EventSchema, { time: timestampNow(), payload }));
  }

  /** The node reports a rollout step for a service generation. */
  deployProgress(
    nodeId: string,
    serviceId: string,
    generation: number,
    stage: DeployStage,
    message = "",
    extra: Pick<MessageInitShape<typeof DeployProgressSchema>, "imageHealthCheck" | "healthTimeout"> = {},
  ): void {
    this.emit(nodeId, {
      case: "deployProgress",
      value: create(DeployProgressSchema, { serviceId, generation: BigInt(generation), stage, message, ...extra }),
    });
  }

  /** The node reports the service running at a generation (healthy), through a state delta. */
  reportRunning(nodeId: string, serviceId: string, generation: number, digest = "", phase = ServicePhase.RUNNING): void {
    const state = this.panel.deps.agents.state;
    if (!state.get(nodeId)?.synced) {
      state.applySnapshot(nodeId, create(StateSnapshotSchema, { epoch: 1n, seq: 0n, appliedRevision: 0n, services: [] }));
      this.seq.set(nodeId, 0n);
    }
    const seq = (this.seq.get(nodeId) ?? 0n) + 1n;
    this.seq.set(nodeId, seq);
    const status = create(ServiceStatusSchema, {
      serviceId,
      generation: BigInt(generation),
      phase,
      instances:
        phase === ServicePhase.STOPPED
          ? []
          : [
              {
                containerId: "c1",
                generation: BigInt(generation),
                replica: 0,
                state: InstanceState.RUNNING,
                health: HealthState.HEALTHY,
                imageDigest: digest,
              },
            ],
    });
    this.emit(nodeId, {
      case: "stateDelta",
      value: create(StateDeltaSchema, { epoch: 1n, seq, change: { case: "serviceUpdated", value: status } }),
    });
  }

  /** Waits until the deploy runner has nothing left to do. */
  async settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await engineFor(this.panel.deps).idle();
      await Bun.sleep(1);
    }
  }
}
