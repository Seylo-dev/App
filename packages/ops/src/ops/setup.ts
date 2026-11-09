// First run. The installer prints a one-time /setup?t=<token> link (valid
// one hour); whoever holds it creates the owner account, with email and
// password or with GitHub (device flow, works while the panel has no
// domain). The remaining setup steps (panel domain, node wildcard domain,
// first project) are ordinary ops of their own modules; setup.finish only
// records that the wizard is done.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { DeviceCode, DevicePollStatus, Email, NewPassword, PersonName, RepoAccess, Viewer } from "../people";
import { permission } from "../permission";
import { Empty, Timestamp } from "../schemas";

const SetupToken = Type.String({ minLength: 1, maxLength: 200, description: "The t= value of the installer's setup link." });

export const SetupStep = Type.Union([
  Type.Literal("owner"),
  Type.Literal("panelDomain"),
  Type.Literal("wildcardDomain"),
  Type.Literal("firstProject"),
]);

export const status = defineOp({
  id: "setup.status",
  kind: "query",
  summary: "Get the first-run state",
  description:
    "Tells the web app whether to show setup or sign-in: whether an owner exists, whether setup is finished, and, when a setup token is given, whether that token is still usable.",
  input: Type.Object({ token: Type.Optional(SetupToken) }),
  output: Type.Object({
    ownerExists: Type.Boolean(),
    /** True once setup.finish ran (or an owner skipped the remaining steps). */
    completed: Type.Boolean(),
    /** Null when no token was given. */
    link: Type.Union([
      Type.Object({
        valid: Type.Boolean(),
        /** When the link stops working; null when it is unknown, used or expired. */
        expiresAt: Type.Union([Timestamp, Type.Null()]),
      }),
      Type.Null(),
    ]),
    /** False while the GitHub OAuth client id is still a placeholder: hide "Continue with GitHub". */
    githubAvailable: Type.Boolean(),
    steps: Type.Array(SetupStep, { description: "The wizard's steps in order." }),
    /** The owner step's "Send anonymous usage reports" switch. */
    telemetry: Type.Optional(
      Type.Object({
        /** What the switch starts with: on, unless the installer ran with --no-telemetry or a variable turns it off. */
        on: Type.Boolean(),
        /** SEYLO_TELEMETRY or DO_NOT_TRACK when one turns telemetry off on this panel (the switch is then off and locked); else null. */
        offBy: Type.Union([Type.String(), Type.Null()]),
        /** The installer ran with --no-telemetry. */
        offAtInstall: Type.Boolean(),
      }),
    ),
  }),
  permission: permission.public(),
  sensitive: { input: ["token"] },
  rateLimit: "strict",
  mcp: false,
  audit: false,
});

export const createOwner = defineOp({
  id: "setup.createOwner",
  kind: "mutation",
  summary: "Create the owner account",
  description:
    "Uses up the setup token, creates the owner with email and password and signs them in (HttpOnly cookie), and stores the telemetry choice: telemetry when given; when omitted, setup.status telemetry.on (on, unless the installer ran with --no-telemetry). Always off while SEYLO_TELEMETRY=off or DO_NOT_TRACK=1 is set on the panel. CONFLICT when an owner already exists.",
  input: Type.Object({
    token: SetupToken,
    email: Email,
    name: Type.Optional(PersonName),
    password: NewPassword,
    /** Anonymous usage reports. Omitted: setup.status telemetry.on (on, unless the installer ran with --no-telemetry). Ignored while a variable turns them off. */
    telemetry: Type.Optional(Type.Boolean()),
  }),
  output: Type.Object({ viewer: Viewer }),
  permission: permission.public(),
  sensitive: { input: ["token", "password"] },
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

export const githubStart = defineOp({
  id: "setup.githubStart",
  kind: "mutation",
  summary: "Start creating the owner with GitHub",
  description:
    "Checks the setup token and starts the GitHub device flow (like gh auth login). Show userCode, open verificationUri, then call setup.githubPoll every intervalSeconds.",
  input: Type.Object({ token: SetupToken, repoAccess: RepoAccess }),
  output: DeviceCode,
  permission: permission.public(),
  sensitive: { input: ["token"], output: ["ticket"] },
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

export const githubPoll = defineOp({
  id: "setup.githubPoll",
  kind: "mutation",
  summary: "Check the GitHub owner sign-up",
  description:
    "Polls the device flow. With status done it uses up the setup token, creates the owner from the GitHub account (primary verified email) and signs them in.",
  input: Type.Object({
    token: SetupToken,
    ticket: Type.String({ minLength: 1, maxLength: 200 }),
    /** Anonymous usage reports. Omitted: setup.status telemetry.on (on, unless the installer ran with --no-telemetry). Ignored while a variable turns them off. */
    telemetry: Type.Optional(Type.Boolean()),
  }),
  output: Type.Object({
    status: DevicePollStatus,
    intervalSeconds: Type.Integer({ minimum: 1 }),
    viewer: Type.Optional(Viewer),
  }),
  permission: permission.public(),
  sensitive: { input: ["token", "ticket"] },
  mcp: false,
  audit: true,
});

export const finish = defineOp({
  id: "setup.finish",
  kind: "mutation",
  summary: "Finish first-run setup",
  description: "Marks the setup wizard as done, so the web app stops offering it. Steps left out can be done later in settings.",
  input: Type.Object({
    skipped: Type.Array(SetupStep, { default: [], description: "Steps the owner chose to skip, for the audit log." }),
  }),
  output: Empty,
  permission: permission.global("setup.finish"),
  mcp: false,
  audit: true,
});
