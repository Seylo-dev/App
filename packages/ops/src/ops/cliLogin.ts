// Laptop CLI sign-in by browser approval ("seylo login <panel>"). The CLI
// starts a request and gets a short user code, a secret device code and a
// URL; it opens the URL (or prints it) and polls with the device code. A
// signed-in person opens the page, checks the code and the computer name,
// picks the scope and approves. The next poll returns a new API key once,
// scoped and expiring, owned by the person who approved. Requests live ten
// minutes; nothing is created until someone approves.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { ActionList } from "../people";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

/** "ABCD-EFGH": eight letters without look-alikes (no 0/O, 1/I/L). */
export const UserCode = Type.String({ pattern: "^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$" });

/** Secret the CLI polls with; never shown in the browser. */
export const DeviceCode = Type.String({ minLength: 20, maxLength: 200 });

export const CliLoginStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("approved"),
  Type.Literal("denied"),
  Type.Literal("expired"),
  /** Approved and the key was already handed out to a poll. */
  Type.Literal("used"),
]);

/** What the approval page shows. */
export const CliLoginRequest = Type.Object({
  userCode: UserCode,
  /** The computer as the CLI named itself, for example "my-laptop (darwin/arm64)". */
  clientName: Type.String(),
  /** IP address the request came from, as the panel saw it. */
  requestedFrom: Type.Union([Type.String(), Type.Null()]),
  status: CliLoginStatus,
  createdAt: Timestamp,
  expiresAt: Timestamp,
});

export const start = defineOp({
  id: "cliLogin.start",
  kind: "mutation",
  summary: "Start a CLI sign-in",
  description:
    "Starts a browser-approved sign-in for the laptop CLI. Show userCode, open verificationUrl, then call cliLogin.poll with deviceCode every intervalSeconds until it is no longer pending.",
  input: Type.Object({
    clientName: Type.String({ minLength: 1, maxLength: 100 }),
  }),
  output: Type.Object({
    userCode: UserCode,
    deviceCode: DeviceCode,
    /** Absolute when the panel knows its address, else a path to put after the panel URL the CLI used. */
    verificationUrl: Type.String(),
    intervalSeconds: Type.Integer({ minimum: 1 }),
    expiresAt: Timestamp,
  }),
  permission: permission.public(),
  sensitive: { output: ["deviceCode"] },
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

export const get = defineOp({
  id: "cliLogin.get",
  kind: "query",
  summary: "Show a CLI sign-in request",
  description: "Returns a pending CLI sign-in by its user code so the approval page can show the computer and when it expires.",
  input: Type.Object({ userCode: UserCode }),
  output: Type.Object({
    request: CliLoginRequest,
    /**
     * The address of the browser asking, as the panel sees it. When it differs
     * from requestedFrom, the CLI runs somewhere else than this browser:
     * someone may be phishing a sign-in.
     */
    viewerAddress: Type.Union([Type.String(), Type.Null()]),
  }),
  permission: permission.signedIn(),
  rateLimit: "strict",
  mcp: false,
  audit: false,
});

export const approve = defineOp({
  id: "cliLogin.approve",
  kind: "mutation",
  summary: "Approve a CLI sign-in",
  description:
    'Approves a pending CLI sign-in: the CLI gets an API key of yours, limited to the given actions ("*" for all of yours), optionally to some projects, read-only or not, expiring after expiresInDays (default 7, like the approval page). Browser sessions only, signed in or confirmed with auth.reauth in the last 15 minutes (FORBIDDEN details.reason "reauth" otherwise).',
  input: Type.Object({
    userCode: UserCode,
    actions: Type.Optional(ActionList),
    projectIds: Type.Optional(Type.Array(Id, { minItems: 1, maxItems: 100, uniqueItems: true })),
    readOnly: Type.Optional(Type.Boolean()),
    expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
  }),
  /** The key is created when the CLI polls next, valid this many days from then. */
  output: Type.Object({ expiresInDays: Type.Integer({ minimum: 1 }) }),
  permission: permission.signedIn(),
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

export const deny = defineOp({
  id: "cliLogin.deny",
  kind: "mutation",
  summary: "Deny a CLI sign-in",
  description: "Refuses a pending CLI sign-in; the CLI's next poll says denied.",
  input: Type.Object({ userCode: UserCode }),
  output: Empty,
  permission: permission.signedIn(),
  mcp: false,
  audit: true,
});

export const poll = defineOp({
  id: "cliLogin.poll",
  kind: "mutation",
  summary: "Check a CLI sign-in",
  description:
    "Polls a CLI sign-in with its device code. Approved returns the API key once (status used afterwards); send it as Authorization: Bearer <token>.",
  input: Type.Object({ deviceCode: DeviceCode }),
  output: Type.Object({
    status: CliLoginStatus,
    /** Present once, on the first poll after approval. */
    key: Type.Optional(
      Type.Object({
        id: Id,
        token: Type.String(),
        name: Type.String(),
        expiresAt: Timestamp,
        /** The person who approved it. */
        email: Type.String(),
      }),
    ),
    intervalSeconds: Type.Integer({ minimum: 1 }),
  }),
  permission: permission.public(),
  sensitive: { input: ["deviceCode"], output: ["key.token"] },
  mcp: false,
  audit: true,
});
