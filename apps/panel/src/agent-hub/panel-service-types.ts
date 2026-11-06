// The shape of the panel's PanelService implementation as the session sees
// it (panel-service.ts builds one; the nodes module attaches it to the
// hub). Kept apart so the session does not depend on the database code.

import type { StatusCode } from "@seylo/proto";
import type { Channel } from "./channel";

/** A status the agent sees (message safe to show). Anything else becomes INTERNAL. */
export class PanelServiceError extends Error {
  override name = "PanelServiceError";
  constructor(
    readonly code: StatusCode,
    message: string,
  ) {
    super(message);
  }
}

/** A stream the agent opened (raw methods move plain bytes on `channel`). */
export interface IncomingStream {
  channel: Channel;
  /** Aborted when the agent cancels or the connection drops. */
  signal: AbortSignal;
}

export interface PanelServiceHandlers {
  /** Sent in ServerHello. */
  readonly capabilities: readonly string[];
  /** A unary call; resolves with the serialized response. */
  call(nodeId: string, wireMethod: string, request: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
  /** A stream; resolves with the serialized response for the final CLOSE. */
  open(nodeId: string, wireMethod: string, request: Uint8Array, stream: IncomingStream): Promise<Uint8Array>;
}
