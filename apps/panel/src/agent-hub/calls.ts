// Panel -> agent calls: the typed surface every module uses through
// deps.agents (see AgentHub in hub.ts). Methods are named by their key in
// AgentService.method ("getNodeFacts", "fsList", ...); request and response
// types come straight from @seylo/proto, so a call can never send the wrong
// message.
//
// Three shapes, chosen by the method's proto signature and its stream_mode
// option (envelope.proto, options.proto):
//
//   unary      deps.agents.call(nodeId, "fsList", { root, path })            -> Promise<FsListResponse>
//   streaming  deps.agents.open(nodeId, "logsFollow", { target, tail })      -> AgentStream (async iterable)
//   raw        deps.agents.openRaw(nodeId, "fsRead", { root, path })         -> RawAgentStream (bytes)
//
// Every failure is an OpError, so op handlers just let it propagate:
//
//   UNAVAILABLE      details.reason "offline"     the node has no live session (or it dropped mid-call)
//   UNAVAILABLE      details.reason "timeout"     no answer within timeoutMs
//   UNAVAILABLE      details.reason "cancelled"   options.signal aborted
//   NOT_IMPLEMENTED  details.reason "capability"  the agent did not advertise the method's capability (old agent)
//   <mapped>         details.reason "agent"       the agent answered with an error status; message is the agent's
//                                                 (safe to show), details.agentStatus is the StatusCode name and
//                                                 details.agentReason the agent's own details.reason, when it sent one

import { getOption, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";
import { OpError, type OpErrorCode } from "@seylo/ops";
import { AgentService, capability, StatusCode, type StreamMode, stream_mode } from "@seylo/proto";

type Methods = typeof AgentService.method;

/** Every AgentService method, by its key in AgentService.method. */
export type AgentMethodName = keyof Methods;

/** Raw methods: declared unary in proto, but move plain bytes between OPEN and CLOSE. */
export type RawDownloadMethodName = "fsRead" | "exportVolume" | "exportRegistry";
export type RawUploadMethodName = "fsWrite" | "uploadBuildContext" | "importVolume" | "importPanelData" | "importRegistry";
export type RawBidiMethodName = "tunnel";
export type RawMethodName = RawDownloadMethodName | RawUploadMethodName | RawBidiMethodName;

/** Plain CALL/RESULT methods. */
export type UnaryMethodName = Exclude<
  { [K in AgentMethodName]: Methods[K]["methodKind"] extends "unary" ? K : never }[AgentMethodName],
  RawMethodName
>;

/** OPEN + delimited messages in DATA: server, client or bidi streaming. */
export type StreamingMethodName = { [K in AgentMethodName]: Methods[K]["methodKind"] extends "unary" ? never : K }[AgentMethodName];

/** Request message (init shape: plain object or created message) of a method. */
export type AgentRequest<M extends AgentMethodName> = MessageInitShape<Methods[M]["input"]>;
/** Response message of a method. */
export type AgentResponse<M extends AgentMethodName> = MessageShape<Methods[M]["output"]>;

export interface CallOptions {
  /** Default 30 s for calls; streams default to no timeout. Sent to the agent as the deadline too. */
  timeoutMs?: number;
  /** Aborting cancels the call (a CLOSE with CANCELLED goes to the agent). */
  signal?: AbortSignal;
  /** Cross-cutting values, for example { "actor": userId }. Never secrets. */
  metadata?: Record<string, string>;
}

export interface StreamOptions extends CallOptions {
  /**
   * Bytes the agent may send before the panel grants more (Open.initial_window).
   * Default 256 KiB. The panel grants credit back as the consumer reads, so a
   * slow reader (a browser on a bad link) slows the agent instead of filling
   * the panel's memory.
   */
  initialWindow?: number;
}

/** How a stream ended; `done` rejects with an OpError instead for anything but OK. */
export interface StreamEnd {
  /** Agent metadata on CLOSE is not part of the protocol; this is only the status message, often empty. */
  message: string;
}

/**
 * A streaming call. Iterate it to read responses (each iteration step
 * consumes credit and lets the transport grant more). Breaking out of the
 * loop or calling cancel() sends CLOSE with CANCELLED.
 */
export interface AgentReadStream<Res> extends AsyncIterable<Res> {
  /** Resolves when the agent closes with OK; rejects with an OpError (see the table at the top). */
  readonly done: Promise<StreamEnd>;
  cancel(reason?: string): void;
}

/** The sending half of client- and bidi-streaming calls (Console, Shell). */
export interface AgentWriteStream<Req> {
  /** Resolves once the message is queued within the send window; awaiting it is the backpressure. */
  send(message: Req): Promise<void>;
  /** Half-close: "I will send no more". The agent may keep sending. */
  closeSend(): void;
}

type StreamKind<M extends StreamingMethodName> = Methods[M]["methodKind"];
type RequestOf<M extends AgentMethodName> = AgentRequest<M>;

export type AgentStream<M extends StreamingMethodName> = AgentReadStream<AgentResponse<M>> &
  (StreamKind<M> extends "server_streaming" ? unknown : AgentWriteStream<RequestOf<M>>);

/**
 * A raw call (files, volume transfer, tunnels). Bytes move as plain DATA
 * frames; the typed response arrives with the agent's CLOSE.
 */
export interface RawAgentStream<M extends RawMethodName> {
  /** The agent's response once it closes with OK; rejects with an OpError otherwise. */
  readonly response: Promise<AgentResponse<M>>;
  cancel(reason?: string): void;
  /** Download and bidi methods: the bytes the agent sends, in chunks. Empty for upload methods. */
  readonly body: M extends RawUploadMethodName ? null : AsyncIterable<Uint8Array>;
  /** Upload and bidi methods: send bytes; resolves when they fit the window. Null for download methods. */
  readonly writer: M extends RawDownloadMethodName ? null : { write(chunk: Uint8Array): Promise<void>; end(): void };
}

/** The descriptor of a method, for reading its options. */
export function agentMethod(name: AgentMethodName) {
  return AgentService.method[name];
}

/** Full wire name, for example "/seylo.agent.v1.AgentService/FsList". */
export function wireMethodName(name: AgentMethodName): string {
  const method = agentMethod(name);
  return `/${AgentService.typeName}/${method.name}`;
}

/** The capability string an agent must advertise before the panel calls this method. */
export function methodCapability(name: AgentMethodName): string {
  return getOption(agentMethod(name), capability);
}

export function methodStreamMode(name: AgentMethodName): StreamMode {
  return getOption(agentMethod(name), stream_mode);
}

/** The node has no live session. */
export function nodeOffline(nodeId: string): OpError {
  return new OpError("UNAVAILABLE", "The node is offline. Try again when it is back.", { reason: "offline", nodeId });
}

export function missingCapability(nodeId: string, method: AgentMethodName): OpError {
  return new OpError("NOT_IMPLEMENTED", "This node's agent is too old for this action. Update the node and try again.", {
    reason: "capability",
    nodeId,
    capability: methodCapability(method),
  });
}

export function callTimedOut(nodeId: string, method: AgentMethodName): OpError {
  return new OpError("UNAVAILABLE", "The node did not answer in time.", { reason: "timeout", nodeId, method });
}

export function callCancelled(nodeId: string, why?: string): OpError {
  return new OpError("UNAVAILABLE", "The request was cancelled.", { reason: "cancelled", nodeId, ...(why ? { why } : {}) });
}

const statusToOpCode: Partial<Record<StatusCode, OpErrorCode>> = {
  [StatusCode.INVALID_ARGUMENT]: "BAD_REQUEST",
  [StatusCode.NOT_FOUND]: "NOT_FOUND",
  [StatusCode.ALREADY_EXISTS]: "CONFLICT",
  [StatusCode.PERMISSION_DENIED]: "FORBIDDEN",
  [StatusCode.FAILED_PRECONDITION]: "CONFLICT",
  [StatusCode.ABORTED]: "CONFLICT",
  [StatusCode.RESOURCE_EXHAUSTED]: "CONFLICT",
  [StatusCode.UNIMPLEMENTED]: "NOT_IMPLEMENTED",
  [StatusCode.UNAVAILABLE]: "UNAVAILABLE",
  [StatusCode.DEADLINE_EXCEEDED]: "UNAVAILABLE",
  [StatusCode.CANCELLED]: "UNAVAILABLE",
};

/**
 * Turns an agent's error status into an OpError. The agent's message is
 * safe to show (envelope.proto, Status.message); INTERNAL and UNKNOWN get a
 * generic message because they may carry internals.
 */
export function agentStatusError(
  nodeId: string,
  status: { code: StatusCode; message: string; details: Record<string, string> } | undefined,
): OpError {
  const code = status ? (statusToOpCode[status.code] ?? "INTERNAL") : "INTERNAL";
  const agentStatus = status ? (StatusCode[status.code] ?? String(status.code)) : "UNKNOWN";
  const message = code === "INTERNAL" || !status?.message ? "The node failed to do this. Its agent log has the details." : status.message;
  // The agent's own reason ("notStarted", "committed") would be lost under reason "agent".
  const agentReason = status?.details?.reason;
  return new OpError(code, message, {
    ...(status?.details ?? {}),
    reason: "agent",
    nodeId,
    agentStatus,
    ...(agentReason ? { agentReason } : {}),
  });
}

/** The agent's status name and reason of a call it refused (agentStatusError); null for any other failure. */
export function agentRefusalOf(error: unknown): { status: string; reason: string | null } | null {
  if (!(error instanceof OpError)) return null;
  const details = error.details as { reason?: string; agentStatus?: string; agentReason?: string } | undefined;
  if (details?.reason !== "agent" || !details.agentStatus) return null;
  return { status: details.agentStatus, reason: details.agentReason ?? null };
}

export const defaultCallTimeoutMs = 30_000;
export const defaultStreamWindow = 256 << 10;
