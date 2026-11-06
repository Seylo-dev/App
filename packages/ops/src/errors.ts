// The one error shape every op returns, on the wire and in code. The web
// client, the CLI and MCP all branch on `code`, never on the HTTP status.

import { type Static, Type } from "@sinclair/typebox";

export const opErrorStatus = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  /** A destructive op from MCP or the AI assistant waits for a person (details.approvalId). */
  APPROVAL_REQUIRED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
  UNAVAILABLE: 503,
} as const;

export type OpErrorCode = keyof typeof opErrorStatus;

export const ErrorBody = Type.Object(
  {
    error: Type.Object({
      code: Type.Union(Object.keys(opErrorStatus).map((code) => Type.Literal(code))),
      /** Safe to show to the person; never contains internals. */
      message: Type.String(),
      /** Machine-readable extras, for example the invalid field path. */
      details: Type.Optional(Type.Record(Type.String(), Type.String())),
    }),
  },
  { $id: "ErrorBody", description: "Returned with every non-2xx response." },
);
export type ErrorBody = Static<typeof ErrorBody>;

export class OpError extends Error {
  override name = "OpError";

  constructor(
    readonly code: OpErrorCode,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
  }

  get status(): number {
    return opErrorStatus[this.code];
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export function isOpErrorCode(value: unknown): value is OpErrorCode {
  return typeof value === "string" && Object.hasOwn(opErrorStatus, value);
}
