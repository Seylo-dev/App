// One agent connection on the panel side. It runs the handshake on stream 0
// (ServerHello -> ClientHello -> HelloAccepted/HelloRejected), then routes
// frames:
//
//   stream 0            EVENT              -> hub.emitEvent
//   even ids (ours)     RESULT/CLOSE       -> unary calls the panel made
//                       DATA/WINDOW/CLOSE  -> streams the panel opened
//   odd ids (agent's)   CALL               -> PanelService unary handlers
//                       OPEN/DATA/WINDOW/CLOSE -> PanelService streams (RegistryTunnel)
//
// Flow control is in channel.ts, the control-first writer in writer.ts and
// the PanelService handlers in panel-service.ts (attached to the hub by
// the nodes module).

import { create, fromBinary, type MessageInitShape, toBinary } from "@bufbuild/protobuf";
import { durationFromMs, timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  CallSchema,
  CloseSchema,
  CONNECTION_STREAM,
  EventSchema,
  type Frame,
  FrameKind,
  HandshakeSchema,
  HelloRejectReason,
  type NodeFacts,
  OpenSchema,
  parseFrame,
  parseWindow,
  ResultSchema,
  StatusCode,
  windowFrame,
} from "@seylo/proto";
import type { PanelDb } from "../db/client";
import { newId } from "../ids";
import type { Logger } from "../logger";
import type { EdgeTicketKey } from "../security/edge-ticket-key";
import {
  agentStatusError,
  type CallOptions,
  callCancelled,
  callTimedOut,
  defaultStreamWindow,
  nodeOffline,
  type StreamOptions,
} from "./calls";
import { Channel, ProtocolViolation } from "./channel";
import { capFields, factsLimits } from "./field-caps";
import { decideHello } from "./handshake";
import type { AgentHub, AgentTransport, ConnectedAgent } from "./hub";
import { PanelServiceError } from "./panel-service-types";
import { signAccept } from "./signature";
import type { OpenedStream } from "./streams";
import { agentVersionAllowed } from "./version";
import { FrameWriter } from "./writer";

/** The socket as the session needs it; the endpoint adapts Bun's. */
export interface AgentSocket {
  /** Bun's send status: bytes sent, -1 queued under backpressure, 0 dropped (FrameWriter closes on that). */
  send(bytes: Uint8Array): number;
  close(code: number, reason: string): void;
  /** Bytes queued in the socket; lets the writer hold DATA back under backpressure. */
  bufferedAmount?(): number;
}

export interface SessionDeps {
  db: PanelDb;
  hub: AgentHub;
  logger: Logger;
  panelId: string;
  panelVersion: string;
  /** The panel's identity key: agents get the public half and verify HelloAccepted.panel_signature and edge tickets with it. */
  edgeTicketKey: EdgeTicketKey;
  /** Only the installer's join token makes the panel node (the panel runs as the installer's managed service). */
  panelNodeFromInstallerOnly?: boolean;
  /** Where this node should dial from now on (HelloAccepted.panel_url/panel_pin); null keeps its address. */
  moveTarget?: (nodeId: string) => { url: string; pin: string } | null;
}

type HandshakeStep = NonNullable<MessageInitShape<typeof HandshakeSchema>["step"]>;
type Settle = (result: { ok: true; bytes: Uint8Array } | { ok: false; error: Error }) => void;

/** WebSocket close codes: 1002 protocol error, 1008 policy violation, 1011 the panel cannot go on. */
const closeProtocolError = 1002;
const closeRejected = 1008;
const closeUnavailable = 1011;

/**
 * Limits on what one agent may make the panel hold. A compromised node may
 * lie about its own services but must not run the panel out of memory:
 * the windows it names for its streams, how many calls and streams it keeps
 * open, and how many bytes wait unread across them are capped.
 */
export const agentLimits = {
  /** Hello must arrive this soon after the socket opens. */
  helloTimeoutMs: 10_000,
  /** Largest initial window an agent-opened stream gets. */
  maxStreamWindow: 1 << 20,
  maxOpenStreams: 64,
  maxPendingCalls: 256,
  /** Bytes received on agent-opened streams and not read yet, summed. */
  maxBufferedBytes: 32 << 20,
  /**
   * Stream-0 EVENT frames (best-effort progress, state deltas, metrics,
   * facts): a token bucket per connection. Past it frames are dropped before
   * they are decoded; a dropped state delta makes the panel fetch a snapshot.
   */
  eventBurst: 2000,
  eventsPerSecond: 200,
};

export class AgentSession {
  readonly sessionId = newId();
  private state: "awaitingHello" | "ready" | "closed" = "awaitingHello";
  private nonce = crypto.getRandomValues(new Uint8Array(32));
  private nodeIdValue = "";
  private facts: NodeFacts | null = null;
  /** Next panel-owned (even) stream id; ids are never reused on a connection. */
  private nextStream = 2;
  /** Highest agent-owned (odd) stream id seen, to refuse reuse. */
  private lastAgentStream = -1;
  private readonly pending = new Map<number, Settle>();
  private readonly channels = new Map<number, Channel>();
  /** Cancels a PanelService call or stream the agent made. */
  private readonly incoming = new Map<number, AbortController>();
  private readonly writer: FrameWriter;
  private connected: ConnectedAgent | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  /** Agent-opened streams and calls in flight, for the caps. */
  private agentStreams = 0;
  private agentCalls = 0;
  /** EVENT token bucket (agentLimits.eventBurst / eventsPerSecond). */
  private eventTokens = agentLimits.eventBurst;
  private eventsRefilledAt = performance.now();
  private eventsDropped = 0;
  private eventsDropLoggedAt = 0;

  constructor(
    private readonly socket: AgentSocket,
    private readonly deps: SessionDeps,
    /** The address the agent connected from (the forwarded one behind a trusted proxy). */
    private readonly remoteIp: string | null = null,
    /** The Host header the agent dialed, lowercased. */
    private readonly host: string | null = null,
    /** The panel base URL the agent dialed, for example "https://panel.example.com" (lowercased). */
    private readonly address: string | null = null,
  ) {
    this.writer = new FrameWriter(socket, () => queueMicrotask(() => this.backpressureClose()));
  }

  get nodeId(): string {
    return this.nodeIdValue;
  }

  /** Sends ServerHello; call once the socket is open. */
  start(): void {
    // An unauthenticated socket that never says hello (pings keep it alive) is closed.
    this.helloTimer = setTimeout(() => {
      if (this.state === "awaitingHello") this.reject(HelloRejectReason.UNSPECIFIED, "No hello within 10 seconds.");
    }, agentLimits.helloTimeoutMs);
    this.helloTimer.unref?.();
    this.sendHandshake({
      case: "serverHello",
      value: {
        panelId: this.deps.panelId,
        panelVersion: this.deps.panelVersion,
        nonce: this.nonce,
        capabilities: [...(this.deps.hub.panelService?.capabilities ?? [])],
      },
    });
  }

  receive(bytes: Uint8Array): void {
    if (this.state === "closed") return;
    let frame: Frame;
    try {
      frame = parseFrame(bytes);
    } catch (error) {
      this.protocolError(`bad frame: ${(error as Error).message}`);
      return;
    }
    try {
      if (this.state === "awaitingHello") this.receiveHello(frame);
      else this.receiveReady(frame);
    } catch (error) {
      if (error instanceof ProtocolViolation) this.protocolError(error.message);
      else this.protocolError(`undecodable ${FrameKind[frame.kind]} payload: ${(error as Error).message}`);
    }
  }

  /** The socket can take more bytes. */
  drained(): void {
    this.writer.drained();
  }

  /** The socket closed, from either side. */
  closed(): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    if (this.state === "ready") this.deps.hub.unregister(this.asConnected());
    this.state = "closed";
    this.writer.close();
    const offline = nodeOffline(this.nodeIdValue);
    for (const settle of this.pending.values()) settle({ ok: false, error: offline });
    this.pending.clear();
    for (const channel of [...this.channels.values()]) channel.finish({ ok: false, error: offline });
    this.channels.clear();
    for (const abort of this.incoming.values()) abort.abort();
    this.incoming.clear();
  }

  // ---- panel -> agent ----

  private allocate(): number {
    const stream = this.nextStream;
    this.nextStream += 2;
    return stream;
  }

  /** AgentTransport.call: one CALL frame, settled by the RESULT, a timeout, an abort or the socket closing. */
  private call(wireMethod: string, request: Uint8Array, options: CallOptions & { method: string }): Promise<Uint8Array> {
    if (this.state !== "ready") return Promise.reject(nodeOffline(this.nodeIdValue));
    const stream = this.allocate();
    const timeoutMs = options.timeoutMs;

    return new Promise<Uint8Array>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => cancel(callCancelled(this.nodeIdValue));
      const settle: Settle = (result) => {
        this.pending.delete(stream);
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (result.ok) resolve(result.bytes);
        else reject(result.error);
      };
      const cancel = (error: Error) => {
        if (!this.pending.has(stream)) return;
        // A CLOSE on a unary call's stream cancels it on the agent.
        this.writer.control(closeFrame(stream, StatusCode.CANCELLED, error.message));
        settle({ ok: false, error });
      };

      if (options.signal?.aborted) {
        reject(callCancelled(this.nodeIdValue));
        return;
      }
      this.pending.set(stream, settle);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => cancel(callTimedOut(this.nodeIdValue, options.method as never)), timeoutMs);
      }
      const call = create(CallSchema, {
        method: wireMethod,
        request,
        metadata: options.metadata ?? {},
        ...deadlineFields(timeoutMs),
      });
      this.writer.control({ kind: FrameKind.CALL, stream, payload: toBinary(CallSchema, call) });
    });
  }

  /** AgentTransport.open: OPEN with the first request; the channel carries DATA both ways. */
  private open(wireMethod: string, request: Uint8Array, options: StreamOptions & { method: string }): OpenedStream {
    if (this.state !== "ready") throw nodeOffline(this.nodeIdValue);
    const stream = this.allocate();
    const window = options.initialWindow ?? defaultStreamWindow;
    const channel = this.newChannel(stream, window);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => cancel(callCancelled(this.nodeIdValue));
    const cancel = (error: Error) => {
      if (channel.ended) return;
      if (this.state === "ready") this.writer.control(closeFrame(stream, StatusCode.CANCELLED, error.message));
      channel.sendClosed = true;
      channel.finish({ ok: false, error });
    };
    void channel.whenEnded().then(() => {
      this.channels.delete(stream);
      this.writer.forget(stream);
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    });
    if (options.signal?.aborted) {
      channel.finish({ ok: false, error: callCancelled(this.nodeIdValue) });
      return { channel, closeSend: () => {}, cancel: () => {} };
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => cancel(callTimedOut(this.nodeIdValue, options.method as never)), options.timeoutMs);
    }

    const open = create(OpenSchema, {
      method: wireMethod,
      request,
      initialWindow: window,
      metadata: options.metadata ?? {},
      ...deadlineFields(options.timeoutMs),
    });
    this.writer.control({ kind: FrameKind.OPEN, stream, payload: toBinary(OpenSchema, open) });
    return {
      channel,
      closeSend: () => {
        if (channel.sendClosed || channel.ended || this.state !== "ready") return;
        channel.sendClosed = true;
        this.writer.afterData(stream, closeFrame(stream, StatusCode.OK, ""));
      },
      cancel,
    };
  }

  private newChannel(stream: number, window: number): Channel {
    const channel = new Channel(stream, window, {
      data: (id, bytes) => this.writer.data(id, bytes),
      window: (id, increment) => this.writer.control(windowFrame(id, increment)),
    });
    this.channels.set(stream, channel);
    return channel;
  }

  // ---- handshake ----

  private receiveHello(frame: Frame): void {
    if (frame.kind !== FrameKind.EVENT || frame.stream !== CONNECTION_STREAM) {
      this.protocolError("expected ClientHello on stream 0");
      return;
    }
    const handshake = fromBinary(HandshakeSchema, frame.payload);
    if (handshake.step.case !== "clientHello") {
      this.protocolError("expected ClientHello");
      return;
    }
    const hello = handshake.step.value;

    const minimum = this.deps.hub.minimumAgentVersion();
    if (!agentVersionAllowed(hello.agentVersion, minimum)) {
      this.reject(
        HelloRejectReason.AGENT_TOO_OLD,
        `This agent (${hello.agentVersion}) is too old for this panel. It needs ${minimum} or newer.`,
        minimum ?? "",
      );
      return;
    }

    // Facts are stored (nodes.facts) and shown; they are not signed, so cut them first.
    if (hello.facts) capFields(hello.facts, factsLimits);
    const decision = decideHello(this.deps.db, this.deps.panelId, this.nonce, hello, {
      remoteIp: this.remoteIp,
      panelNodeFromInstallerOnly: this.deps.panelNodeFromInstallerOnly ?? false,
    });
    if (!decision.ok) {
      this.reject(decision.reason, decision.message);
      return;
    }

    this.nodeIdValue = decision.nodeId;
    this.facts = hello.facts ?? null;
    if (!this.deps.hub.register(this.asConnected())) {
      this.reject(HelloRejectReason.ALREADY_CONNECTED, "This node is already connected to the panel.");
      return;
    }
    this.state = "ready";
    const move = this.moveTargetFor(decision.nodeId);
    const panelUrl = move?.url ?? "";
    const panelPin = move?.pin ?? "";
    // Proves this panel holds the identity key the node recorded at its first connect (signature.ts).
    const panelSignature = signAccept(this.deps.edgeTicketKey.privateKey, {
      panelId: this.deps.panelId,
      nodeId: decision.nodeId,
      sessionId: this.sessionId,
      nonce: this.nonce,
      clientSignature: hello.credential.value?.signature ?? new Uint8Array(),
      panelUrl,
      panelPin,
    });
    this.sendHandshake({
      case: "accepted",
      value: {
        nodeId: decision.nodeId,
        sessionId: this.sessionId,
        edgeTicketPublicKey: this.deps.edgeTicketKey.publicKey,
        panelUrl,
        panelPin,
        panelSignature,
      },
    });
    this.deps.logger.info({ nodeId: decision.nodeId, sessionId: this.sessionId, joined: decision.joined }, "agent connected");
  }

  /** The address to move this node to; a failure here never fails the handshake. */
  private moveTargetFor(nodeId: string): { url: string; pin: string } | null {
    try {
      return this.deps.moveTarget?.(nodeId) ?? null;
    } catch (error) {
      this.deps.logger.warn({ nodeId, err: error }, "could not work out the agent address to move to");
      return null;
    }
  }

  // ---- frames after the handshake ----

  private receiveReady(frame: Frame): void {
    if (frame.stream === CONNECTION_STREAM) {
      if (frame.kind !== FrameKind.EVENT) throw new ProtocolViolation(`${FrameKind[frame.kind]} on stream 0`);
      if (!this.takeEventToken()) return;
      const event = fromBinary(EventSchema, frame.payload);
      if (event.payload.case === "nodeFacts") capFields(event.payload.value, factsLimits);
      this.deps.hub.emitEvent(this.nodeId, event);
      return;
    }
    if (frame.stream % 2 === 0) this.receivePanelStream(frame);
    else this.receiveAgentStream(frame);
  }

  /** Whether one more EVENT fits the bucket; a drop is logged once a minute with the count. */
  private takeEventToken(): boolean {
    const now = performance.now();
    this.eventTokens = Math.min(
      agentLimits.eventBurst,
      this.eventTokens + ((now - this.eventsRefilledAt) / 1000) * agentLimits.eventsPerSecond,
    );
    this.eventsRefilledAt = now;
    if (this.eventTokens >= 1) {
      this.eventTokens -= 1;
      return true;
    }
    this.eventsDropped += 1;
    if (now - this.eventsDropLoggedAt >= 60_000) {
      this.eventsDropLoggedAt = now;
      this.deps.logger.warn(
        { nodeId: this.nodeIdValue, dropped: this.eventsDropped, perSecond: agentLimits.eventsPerSecond },
        "agent sends events faster than the panel takes them; dropping the excess",
      );
    }
    return false;
  }

  /** Frames on streams the panel opened (even ids). */
  private receivePanelStream(frame: Frame): void {
    if (frame.stream >= this.nextStream) {
      throw new ProtocolViolation(`frame on panel stream ${frame.stream}, which the panel never opened`);
    }
    const settle = this.pending.get(frame.stream);
    if (settle) {
      if (frame.kind === FrameKind.RESULT) {
        const result = fromBinary(ResultSchema, frame.payload);
        if (result.status?.code === StatusCode.OK) settle({ ok: true, bytes: result.response });
        else settle({ ok: false, error: agentStatusError(this.nodeIdValue, result.status) });
      } else if (frame.kind === FrameKind.CLOSE) {
        // The agent ended the call without a RESULT (for example it refused it).
        const close = fromBinary(CloseSchema, frame.payload);
        settle({ ok: false, error: agentStatusError(this.nodeIdValue, close.status) });
      }
      return;
    }
    const channel = this.channels.get(frame.stream);
    // Late frames for calls and streams that already ended.
    if (!channel) return;
    switch (frame.kind) {
      case FrameKind.DATA:
        channel.receive(frame.payload);
        return;
      case FrameKind.WINDOW:
        channel.grant(parseWindow(frame.payload));
        return;
      case FrameKind.CLOSE: {
        const close = fromBinary(CloseSchema, frame.payload);
        if (close.status?.code === StatusCode.OK) channel.finish({ ok: true, response: close.response });
        else channel.finish({ ok: false, error: agentStatusError(this.nodeIdValue, close.status) });
        return;
      }
      default:
        throw new ProtocolViolation(`${FrameKind[frame.kind]} on a panel stream`);
    }
  }

  /** Frames on streams the agent opened (odd ids): PanelService calls and streams. */
  private receiveAgentStream(frame: Frame): void {
    if (frame.kind === FrameKind.CALL || frame.kind === FrameKind.OPEN) {
      if (frame.stream <= this.lastAgentStream) throw new ProtocolViolation(`agent reused stream ${frame.stream}`);
      this.lastAgentStream = frame.stream;
      if (frame.kind === FrameKind.CALL) this.serveCall(frame.stream, fromBinary(CallSchema, frame.payload));
      else this.serveOpen(frame.stream, fromBinary(OpenSchema, frame.payload));
      return;
    }
    const channel = this.channels.get(frame.stream);
    switch (frame.kind) {
      case FrameKind.DATA:
        channel?.receive(frame.payload);
        if (channel && this.agentBuffered() > agentLimits.maxBufferedBytes) {
          throw new ProtocolViolation(`more than ${agentLimits.maxBufferedBytes} bytes wait unread on agent streams`);
        }
        return;
      case FrameKind.WINDOW:
        channel?.grant(parseWindow(frame.payload));
        return;
      case FrameKind.CLOSE: {
        const close = fromBinary(CloseSchema, frame.payload);
        if (close.status?.code === StatusCode.OK) {
          channel?.endInbound();
        } else {
          // Cancelled by the agent: stop the handler; nothing more is sent.
          this.incoming.get(frame.stream)?.abort();
          channel?.finish({ ok: false, error: callCancelled(this.nodeIdValue) });
        }
        return;
      }
      default:
        throw new ProtocolViolation(`${FrameKind[frame.kind]} on an agent stream`);
    }
  }

  private serveCall(stream: number, call: { method: string; request: Uint8Array }): void {
    const service = this.deps.hub.panelService;
    if (!service) {
      this.sendResult(stream, { code: StatusCode.UNIMPLEMENTED, message: unimplementedMessage(call.method) });
      return;
    }
    if (this.agentCalls >= agentLimits.maxPendingCalls) {
      this.sendResult(stream, { code: StatusCode.RESOURCE_EXHAUSTED, message: "Too many calls in flight. Retry later." });
      return;
    }
    const abort = new AbortController();
    this.incoming.set(stream, abort);
    this.agentCalls += 1;
    service
      .call(this.nodeIdValue, call.method, call.request, abort.signal)
      .then(
        (response) => this.sendResult(stream, { code: StatusCode.OK, message: "" }, response),
        (error) => this.sendResult(stream, this.statusOf(error, call.method)),
      )
      .finally(() => {
        this.agentCalls -= 1;
        this.incoming.delete(stream);
      });
  }

  /** Bytes waiting unread on streams the agent opened. */
  private agentBuffered(): number {
    let total = 0;
    for (const [id, channel] of this.channels) if (id % 2 === 1) total += channel.buffered;
    return total;
  }

  private serveOpen(stream: number, open: { method: string; request: Uint8Array; initialWindow: number }): void {
    const service = this.deps.hub.panelService;
    if (!service) {
      this.writer.control(closeFrame(stream, StatusCode.UNIMPLEMENTED, unimplementedMessage(open.method)));
      return;
    }
    if (this.agentStreams >= agentLimits.maxOpenStreams) {
      this.writer.control(closeFrame(stream, StatusCode.RESOURCE_EXHAUSTED, "Too many open streams. Retry later."));
      return;
    }
    // The agent names its window; more than maxStreamWindow is never needed and would let it buffer gigabytes here.
    const window = Math.min(open.initialWindow || defaultStreamWindow, agentLimits.maxStreamWindow);
    const channel = this.newChannel(stream, window);
    const abort = new AbortController();
    this.incoming.set(stream, abort);
    this.agentStreams += 1;
    service
      .open(this.nodeIdValue, open.method, open.request, { channel, signal: abort.signal })
      .then(
        (response) => {
          if (this.state === "ready" && !channel.ended) this.writer.afterData(stream, closeFrame(stream, StatusCode.OK, "", response));
        },
        (error) => {
          if (this.state !== "ready" || channel.ended) return;
          const status = this.statusOf(error, open.method);
          this.writer.afterData(stream, closeFrame(stream, status.code, status.message));
        },
      )
      .finally(() => {
        this.agentStreams -= 1;
        this.incoming.delete(stream);
        channel.finish({ ok: true, response: new Uint8Array() });
        this.channels.delete(stream);
      });
  }

  private statusOf(error: unknown, method: string): { code: StatusCode; message: string } {
    if (error instanceof PanelServiceError) return { code: error.code, message: error.message };
    this.deps.logger.error({ err: error, nodeId: this.nodeIdValue, method }, "panel service handler failed");
    return { code: StatusCode.INTERNAL, message: "The panel failed to handle this request." };
  }

  private sendResult(stream: number, status: { code: StatusCode; message: string }, response?: Uint8Array): void {
    if (this.state !== "ready") return;
    const result = create(ResultSchema, { status: { ...status, details: {} }, response: response ?? new Uint8Array() });
    this.writer.control({ kind: FrameKind.RESULT, stream, payload: toBinary(ResultSchema, result) });
  }

  // ---- errors and helpers ----

  private reject(reason: HelloRejectReason, message: string, minAgentVersion = ""): void {
    this.deps.logger.warn(
      { reason: HelloRejectReason[reason], nodeId: this.nodeIdValue || undefined, remoteIp: this.remoteIp },
      "agent rejected",
    );
    this.sendHandshake({ case: "rejected", value: { reason, message, minAgentVersion } });
    this.state = "closed";
    this.writer.close();
    this.socket.close(closeRejected, message.slice(0, 120));
  }

  /** The socket dropped a frame (the agent stopped reading): end the session so both sides start over. */
  private backpressureClose(): void {
    if (this.state === "closed") return;
    this.deps.logger.warn(
      { nodeId: this.nodeIdValue || undefined },
      "agent socket dropped a frame under backpressure (the agent stopped reading); closing the connection",
    );
    this.closed();
    this.socket.close(closeUnavailable, "the agent stopped reading");
  }

  private protocolError(reason: string): void {
    this.deps.logger.warn({ nodeId: this.nodeIdValue || undefined, reason }, "agent protocol error");
    this.closed();
    this.socket.close(closeProtocolError, reason.slice(0, 120));
  }

  private sendHandshake(step: HandshakeStep): void {
    const payload = toBinary(HandshakeSchema, create(HandshakeSchema, { step }));
    this.writer.control({ kind: FrameKind.EVENT, stream: CONNECTION_STREAM, payload });
  }

  private asConnected(): ConnectedAgent {
    if (!this.connected) {
      const transport: AgentTransport = {
        call: (method, request, options) => this.call(method, request, options),
        open: (method, request, options) => this.open(method, request, options),
      };
      this.connected = {
        nodeId: this.nodeIdValue,
        sessionId: this.sessionId,
        facts: this.facts,
        transport,
        host: this.host,
        address: this.address,
        close: (reason: string) => this.socket.close(1000, reason),
      };
    }
    return this.connected;
  }
}

function closeFrame(stream: number, code: StatusCode, message: string, response?: Uint8Array): Frame {
  const close = create(CloseSchema, { status: { code, message, details: {} }, response: response ?? new Uint8Array() });
  return { kind: FrameKind.CLOSE, stream, payload: toBinary(CloseSchema, close) };
}

function unimplementedMessage(method: string): string {
  return `${method} is not implemented by this panel.`;
}

/**
 * Deadline fields for CALL and OPEN, stamped from one clock reading: the
 * relative `timeout` lets an agent whose clock runs ahead count from its own
 * receive time, and `deadline - timeout` tells it how far the clocks differ.
 * Older agents read only `deadline`.
 */
function deadlineFields(timeoutMs: number | undefined) {
  if (!timeoutMs || timeoutMs <= 0) return {};
  return { deadline: timestampFromDate(new Date(Date.now() + timeoutMs)), timeout: durationFromMs(timeoutMs) };
}
