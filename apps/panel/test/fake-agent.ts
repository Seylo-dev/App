// A fake node agent for panel tests. It speaks the real protocol over a
// real WebSocket: signed handshake (join or resume), CALL/RESULT, streams
// with credit flow control (OPEN/DATA/WINDOW/CLOSE), raw byte methods,
// EVENT frames, and calls to PanelService. Tests register handlers by the
// Go method name ("FsList", "LogsFollow") and assert on what the panel sent.

import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { create, type DescMessage, fromBinary, getOption, type MessageInitShape, type MessageShape, toBinary } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import {
  AgentService,
  CallSchema,
  CloseSchema,
  CONNECTION_STREAM,
  capability,
  EventSchema,
  encodeFrame,
  type Frame,
  FrameKind,
  HandshakeSchema,
  type HelloAccepted,
  type HelloRejected,
  OpenSchema,
  PanelService,
  parseFrame,
  parseWindow,
  ResultSchema,
  StatusCode,
  windowFrame,
} from "@seylo/proto";
import { Channel, DelimitedDecoder, encodeDelimited } from "../src/agent-hub/channel";
import { agentConnectPath, agentSubprotocol } from "../src/agent-hub/endpoint";
import { helloSignedBytes } from "../src/agent-hub/signature";

type AnyMethod = (typeof AgentService.methods)[number];
type Status = { code: StatusCode; message?: string; details?: Record<string, string> };

/** Throw from a handler to answer with this status (and its machine-readable details). */
export class FakeStatus extends Error {
  constructor(
    readonly code: StatusCode,
    message = "",
    readonly details: Record<string, string> = {},
  ) {
    super(message);
  }
}

export interface FakeStream {
  /** Delimited message streams: send one response message. */
  send(message: unknown): Promise<void>;
  /** Next request message from the panel, or null after its half-close. */
  recv(): Promise<unknown | null>;
  /** Raw methods: bytes. */
  write(bytes: Uint8Array): Promise<void>;
  read(): Promise<Uint8Array | null>;
  /** Aborted when the panel cancels. */
  signal: AbortSignal;
  channel: Channel;
}

type UnaryHandler = (request: any, metadata: Record<string, string>) => unknown | Promise<unknown>;
type StreamHandler = (first: any, stream: FakeStream, metadata: Record<string, string>) => Promise<unknown>;

export interface FakeAgentOptions {
  url: string;
  panelId: string;
  /** Join with this token (first connect); otherwise resume with nodeId. */
  token?: string;
  nodeId?: string;
  key?: { privateKey: KeyObject; publicKey: Uint8Array };
  capabilities?: string[];
  facts?: Record<string, unknown>;
  agentVersion?: string;
  name?: string;
  /** Default handlers for state sync (snapshot, SyncDesired, ApplyService, RemoveService). Default true. */
  stateSync?: boolean;
  /** ClientHello.stay_on_address: ask for Panel address "stay" (set-panel, a join with --pin at an IP). */
  stayOnAddress?: boolean;
  /** ClientHello.away: why the agent could not connect meanwhile. */
  away?: { lastError: string; sinceMs?: number; failedAttempts?: number };
  /** Extra headers on the WebSocket upgrade (what a proxy in front of the panel adds). */
  headers?: Record<string, string>;
}

export function agentKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: new Uint8Array(Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url")) };
}

/** Every capability AgentService defines: an agent that can do everything. */
export const allCapabilities = [...new Set(AgentService.methods.map((m) => getOption(m, capability)))];

export class FakeAgent {
  nodeId = "";
  rejected: HelloRejected | null = null;
  /** The last HelloAccepted, for tests of what the panel tells the agent on connect. */
  accepted: HelloAccepted | null = null;
  readonly key: { privateKey: KeyObject; publicKey: Uint8Array };
  /** Requests the panel sent, by method name, in order. */
  readonly received = new Map<string, unknown[]>();
  appliedRevision = 0n;
  /** Services as the agent believes the panel wants them (from SyncDesired/Apply/Remove). */
  readonly desired = new Map<string, unknown>();
  private ws!: WebSocket;
  private readonly unary = new Map<string, UnaryHandler>();
  private readonly streams = new Map<string, StreamHandler>();
  private readonly channels = new Map<number, Channel>();
  private readonly aborts = new Map<number, AbortController>();
  private readonly pendingCalls = new Map<number, (frame: Frame) => void>();
  private nextStream = 1;
  private closedWaiters: (() => void)[] = [];
  closed = false;

  constructor(private readonly options: FakeAgentOptions) {
    this.key = options.key ?? agentKey();
    if (options.stateSync !== false) this.installStateSync();
  }

  /** Connects and finishes the handshake. Resolves even when rejected (see `rejected`). */
  async connect(): Promise<this> {
    const address = `${this.options.url.replace(/^http/, "ws")}${agentConnectPath}`;
    this.ws = this.options.headers
      ? new WebSocket(address, { protocols: [agentSubprotocol], headers: this.options.headers } as never)
      : new WebSocket(address, [agentSubprotocol]);
    this.ws.binaryType = "arraybuffer";
    let helloDone: (() => void) | undefined;
    const handshake = new Promise<void>((resolve) => {
      helloDone = resolve;
    });
    this.ws.onmessage = (event) => {
      const frame = parseFrame(new Uint8Array(event.data as ArrayBuffer));
      if (frame.stream === CONNECTION_STREAM && !this.nodeId && !this.rejected) {
        this.onHandshake(frame, () => helloDone?.());
        return;
      }
      this.onFrame(frame);
    };
    this.ws.onclose = () => {
      this.closed = true;
      helloDone?.();
      for (const channel of this.channels.values()) channel.finish({ ok: false, error: new Error("closed") });
      for (const abort of this.aborts.values()) abort.abort();
      for (const wake of this.closedWaiters.splice(0)) wake();
    };
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    await handshake;
    return this;
  }

  handle(method: string, handler: UnaryHandler): this {
    this.unary.set(method, handler);
    return this;
  }

  handleStream(method: string, handler: StreamHandler): this {
    this.streams.set(method, handler);
    return this;
  }

  requests<T = any>(method: string): T[] {
    return (this.received.get(method) ?? []) as T[];
  }

  /** Waits until the panel called `method` at least `count` times. */
  async waitFor(method: string, count = 1, timeoutMs = 2000): Promise<any[]> {
    const until = Date.now() + timeoutMs;
    while (this.requests(method).length < count) {
      if (Date.now() > until) throw new Error(`timed out waiting for ${method} x${count} (got ${this.requests(method).length})`);
      await Bun.sleep(5);
    }
    return this.requests(method);
  }

  /** Sends a best-effort EVENT frame. */
  event(event: MessageInitShape<typeof EventSchema>): void {
    this.send({ kind: FrameKind.EVENT, stream: CONNECTION_STREAM, payload: toBinary(EventSchema, create(EventSchema, event)) });
  }

  /** Calls a PanelService unary method; resolves with the response or rejects with the status. */
  async callPanel<I extends DescMessage, O extends DescMessage>(name: string, input: I, output: O, request: MessageInitShape<I>) {
    const stream = this.allocate();
    const method = PanelService.methods.find((m) => m.name === name);
    if (!method) throw new Error(`no PanelService method ${name}`);
    const frame = await new Promise<Frame>((resolve) => {
      this.pendingCalls.set(stream, resolve);
      const call = create(CallSchema, { method: `/${PanelService.typeName}/${name}`, request: toBinary(input, create(input, request)) });
      this.send({ kind: FrameKind.CALL, stream, payload: toBinary(CallSchema, call) });
    });
    const result = fromBinary(ResultSchema, frame.payload);
    if (result.status?.code !== StatusCode.OK) throw new FakeStatus(result.status?.code ?? StatusCode.UNKNOWN, result.status?.message);
    return fromBinary(output, result.response) as MessageShape<O>;
  }

  /** Opens a raw PanelService stream (RegistryTunnel). */
  openPanelRaw(name: string, request: Uint8Array = new Uint8Array(), window = 256 << 10) {
    const stream = this.allocate();
    const channel = this.newChannel(stream, window);
    const end = new Promise<{ status: Status; response: Uint8Array }>((resolve) => {
      this.pendingCalls.set(stream, (frame) => {
        const close = fromBinary(CloseSchema, frame.payload);
        resolve({ status: { code: close.status?.code ?? StatusCode.UNKNOWN, message: close.status?.message }, response: close.response });
      });
    });
    const open = create(OpenSchema, { method: `/${PanelService.typeName}/${name}`, request, initialWindow: window });
    this.send({ kind: FrameKind.OPEN, stream, payload: toBinary(OpenSchema, open) });
    return {
      channel,
      end,
      write: (bytes: Uint8Array) => channel.write(bytes),
      read: () => channel.read(),
      closeSend: () => this.sendClose(stream, { code: StatusCode.OK }),
    };
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const done = new Promise<void>((resolve) => this.closedWaiters.push(resolve));
    this.ws.close();
    return done;
  }

  // ---- internals ----

  private installStateSync(): void {
    this.handle("GetStateSnapshot", () => ({ snapshot: { epoch: 1n, seq: 0n, appliedRevision: this.appliedRevision, services: [] } }));
    this.handle("GetNodeFacts", () => ({ facts: { hostname: "fake", capabilities: this.options.capabilities ?? [] } }));
    this.handle("SyncDesired", (request: any) => {
      this.desired.clear();
      for (const service of request.state?.services ?? []) this.desired.set(service.id, service);
      this.appliedRevision = request.state?.revision ?? 0n;
      return { acceptedRevision: this.appliedRevision };
    });
    this.handle("ApplyService", (request: any) => {
      if (request.service) this.desired.set(request.service.id, request.service);
      this.appliedRevision = request.revision;
      return { acceptedRevision: request.revision };
    });
    this.handle("RemoveService", (request: any) => {
      this.desired.delete(request.serviceId);
      this.appliedRevision = request.revision;
      return { acceptedRevision: request.revision };
    });
  }

  private record(name: string, request: unknown): void {
    const list = this.received.get(name) ?? [];
    list.push(request);
    this.received.set(name, list);
  }

  private allocate(): number {
    const id = this.nextStream;
    this.nextStream += 2;
    return id;
  }

  private send(frame: Frame): void {
    if (this.closed) return;
    this.ws.send(encodeFrame(frame));
  }

  private sendClose(stream: number, status: Status, response?: Uint8Array): void {
    const close = create(CloseSchema, {
      status: { code: status.code, message: status.message ?? "", details: {} },
      response: response ?? new Uint8Array(),
    });
    this.send({ kind: FrameKind.CLOSE, stream, payload: toBinary(CloseSchema, close) });
  }

  private newChannel(stream: number, window: number): Channel {
    const channel = new Channel(stream, window, {
      data: (id, bytes) => this.send({ kind: FrameKind.DATA, stream: id, payload: bytes.slice() }),
      window: (id, increment) => this.send(windowFrame(id, increment)),
    });
    this.channels.set(stream, channel);
    return channel;
  }

  private onHandshake(frame: Frame, done: () => void): void {
    const handshake = fromBinary(HandshakeSchema, frame.payload);
    const step = handshake.step;
    if (step.case === "serverHello") {
      const nonce = step.value.nonce;
      const resumeId = this.options.token ? "" : (this.options.nodeId ?? "");
      const signature = new Uint8Array(sign(null, helloSignedBytes(this.options.panelId, resumeId, nonce), this.key.privateKey));
      const credential = this.options.token
        ? {
            case: "join" as const,
            value: { token: this.options.token, publicKey: this.key.publicKey, signature, requestedName: this.options.name ?? "" },
          }
        : { case: "resume" as const, value: { nodeId: resumeId, signature } };
      const hello = create(HandshakeSchema, {
        step: {
          case: "clientHello",
          value: {
            agentVersion: this.options.agentVersion ?? "dev",
            facts: {
              hostname: "fake-host",
              arch: "amd64",
              ...(this.options.facts ?? {}),
              capabilities: this.options.capabilities ?? [],
            } as never,
            credential,
            stayOnAddress: this.options.stayOnAddress ?? false,
            ...(this.options.away
              ? {
                  away: {
                    lastError: this.options.away.lastError,
                    failedAttempts: this.options.away.failedAttempts ?? 1,
                    ...(this.options.away.sinceMs !== undefined ? { since: timestampFromMs(this.options.away.sinceMs) } : {}),
                  },
                }
              : {}),
          },
        },
      });
      this.send({ kind: FrameKind.EVENT, stream: CONNECTION_STREAM, payload: toBinary(HandshakeSchema, hello) });
    } else if (step.case === "accepted") {
      this.accepted = step.value;
      this.nodeId = step.value.nodeId;
      // Later connects resume with the node id.
      this.options.nodeId = step.value.nodeId;
      this.options.token = undefined;
      done();
    } else if (step.case === "rejected") {
      this.rejected = step.value;
      done();
    }
  }

  private onFrame(frame: Frame): void {
    if (frame.stream % 2 === 1) {
      this.onOwnStream(frame);
      return;
    }
    switch (frame.kind) {
      case FrameKind.CALL:
        void this.serveCall(frame.stream, fromBinary(CallSchema, frame.payload));
        return;
      case FrameKind.OPEN:
        void this.serveOpen(frame.stream, fromBinary(OpenSchema, frame.payload));
        return;
      case FrameKind.DATA:
        this.channels.get(frame.stream)?.receive(frame.payload);
        return;
      case FrameKind.WINDOW:
        this.channels.get(frame.stream)?.grant(parseWindow(frame.payload));
        return;
      case FrameKind.CLOSE: {
        const close = fromBinary(CloseSchema, frame.payload);
        if (close.status?.code === StatusCode.OK) this.channels.get(frame.stream)?.endInbound();
        else {
          this.aborts.get(frame.stream)?.abort();
          this.channels.get(frame.stream)?.finish({ ok: false, error: new Error("cancelled") });
        }
        return;
      }
    }
  }

  private onOwnStream(frame: Frame): void {
    const channel = this.channels.get(frame.stream);
    switch (frame.kind) {
      case FrameKind.RESULT:
        this.pendingCalls.get(frame.stream)?.(frame);
        this.pendingCalls.delete(frame.stream);
        return;
      case FrameKind.DATA:
        channel?.receive(frame.payload);
        return;
      case FrameKind.WINDOW:
        channel?.grant(parseWindow(frame.payload));
        return;
      case FrameKind.CLOSE:
        channel?.finish({ ok: true, response: new Uint8Array() });
        this.pendingCalls.get(frame.stream)?.(frame);
        this.pendingCalls.delete(frame.stream);
        return;
    }
  }

  private method(wire: string): AnyMethod | undefined {
    const name = wire.split("/").pop();
    return AgentService.methods.find((m) => m.name === name);
  }

  private async serveCall(stream: number, call: { method: string; request: Uint8Array; metadata: Record<string, string> }) {
    const method = this.method(call.method);
    const reply = (status: Status, response?: Uint8Array) => {
      const result = create(ResultSchema, {
        status: { code: status.code, message: status.message ?? "", details: status.details ?? {} },
        response: response ?? new Uint8Array(),
      });
      this.send({ kind: FrameKind.RESULT, stream, payload: toBinary(ResultSchema, result) });
    };
    const handler = method && this.unary.get(method.name);
    if (!method || !handler) {
      reply({ code: StatusCode.UNIMPLEMENTED, message: "not implemented by the fake agent" });
      return;
    }
    const request = fromBinary(method.input, call.request);
    this.record(method.name, request);
    try {
      const response = await handler(request, call.metadata);
      reply({ code: StatusCode.OK }, toBinary(method.output, create(method.output, (response ?? {}) as never)));
    } catch (error) {
      if (error instanceof FakeStatus) reply({ code: error.code, message: error.message, details: error.details });
      else reply({ code: StatusCode.INTERNAL, message: String(error) });
    }
  }

  private async serveOpen(
    stream: number,
    open: { method: string; request: Uint8Array; initialWindow: number; metadata: Record<string, string> },
  ) {
    const method = this.method(open.method);
    const handler = method && this.streams.get(method.name);
    if (!method || !handler) {
      this.sendClose(stream, { code: StatusCode.UNIMPLEMENTED, message: "not implemented by the fake agent" });
      return;
    }
    const channel = this.newChannel(stream, open.initialWindow);
    const abort = new AbortController();
    this.aborts.set(stream, abort);
    const first = fromBinary(method.input, open.request);
    this.record(method.name, first);
    const decoder = new DelimitedDecoder();
    const ready: Uint8Array[] = [];
    const fake: FakeStream = {
      channel,
      signal: abort.signal,
      send: (message) => channel.write(encodeDelimited(toBinary(method.output, create(method.output, message as never)))),
      async recv() {
        for (;;) {
          const next = ready.shift();
          if (next) return fromBinary(method.input, next);
          const chunk = await channel.read();
          if (chunk === null) return null;
          ready.push(...decoder.push(chunk));
        }
      },
      write: (bytes) => channel.write(bytes),
      read: () => channel.read(),
    };
    try {
      const response = await handler(first, fake, open.metadata);
      if (abort.signal.aborted) return;
      const bytes =
        method.methodKind === "unary" ? toBinary(method.output, create(method.output, (response ?? {}) as never)) : new Uint8Array();
      this.sendClose(stream, { code: StatusCode.OK }, bytes);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof FakeStatus) this.sendClose(stream, { code: error.code, message: error.message });
      else this.sendClose(stream, { code: StatusCode.INTERNAL, message: String(error) });
    } finally {
      this.channels.delete(stream);
      this.aborts.delete(stream);
    }
  }
}
