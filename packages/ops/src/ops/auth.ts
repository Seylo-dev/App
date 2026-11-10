// Sign-in for people and their own account security. Sessions travel as an
// HttpOnly cookie that the panel sets; API keys and MCP tokens use the
// Authorization header instead (see CONTRACTS.md "Permission model").
//
// Every way to sign in returns a LoginResult. When the account has a second
// factor, no session is created yet: the result carries a 5-minute ticket
// that auth.verifySecondFactor exchanges for the session.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import {
  DeviceCode,
  DevicePollStatus,
  Email,
  LoginResult,
  NewPassword,
  PersonName,
  RepoAccess,
  Role,
  SecondFactorMethod,
  Viewer,
  WebAuthnJson,
} from "../people";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

// Re-exported so `auth.Role` and `auth.Viewer` keep working.
export { Role, Viewer };

const Ticket = Type.String({ minLength: 1, maxLength: 200 });

// ---------------------------------------------------------------------------
// Sign in and out

export const login = defineOp({
  id: "auth.login",
  kind: "mutation",
  summary: "Sign in with email and password",
  description:
    "Checks the email and password. Without 2FA it starts a session (HttpOnly cookie). With 2FA it returns status secondFactor and a ticket for auth.verifySecondFactor.",
  input: Type.Object({
    email: Email,
    password: Type.String({ minLength: 1, maxLength: 1024 }),
  }),
  output: LoginResult,
  permission: permission.public(),
  sensitive: { input: ["password"], output: ["challenge.ticket"] },
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

export const verifySecondFactor = defineOp({
  id: "auth.verifySecondFactor",
  kind: "mutation",
  summary: "Finish signing in with a 2FA code",
  description:
    "Exchanges the ticket from a secondFactor LoginResult and a 6-digit authenticator code (or one unused recovery code) for a session. A recovery code is used up.",
  input: Type.Object({
    ticket: Ticket,
    method: SecondFactorMethod,
    code: Type.String({ minLength: 6, maxLength: 32 }),
  }),
  output: Type.Object({
    viewer: Viewer,
    /** Unused recovery codes left after this sign-in; the screen warns when it is low. */
    recoveryCodesLeft: Type.Integer({ minimum: 0 }),
  }),
  permission: permission.public(),
  sensitive: { input: ["ticket", "code"] },
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

export const logout = defineOp({
  id: "auth.logout",
  kind: "mutation",
  summary: "Sign out",
  description: "Ends the current session and clears its cookie. API keys are not affected.",
  input: Empty,
  output: Empty,
  permission: permission.signedIn(),
  mcp: false,
  audit: true,
});

export const whoami = defineOp({
  id: "auth.whoami",
  kind: "query",
  summary: "Get the signed-in person",
  description: "Returns who the current session or API key acts as, and through which credential.",
  input: Empty,
  output: Type.Object({
    viewer: Viewer,
    via: Type.Union([Type.Literal("session"), Type.Literal("apiKey")]),
  }),
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

// ---------------------------------------------------------------------------
// Own profile and preferences

export const updateProfile = defineOp({
  id: "auth.updateProfile",
  kind: "mutation",
  summary: "Change your name",
  description: "Changes the display name of the signed-in person. The email changes with auth.changeEmail.",
  input: Type.Object({ name: PersonName }),
  output: Type.Object({ viewer: Viewer }),
  permission: permission.signedIn(),
  mcp: false,
  audit: true,
});

export const changeEmail = defineOp({
  id: "auth.changeEmail",
  kind: "mutation",
  summary: "Change your email",
  description:
    'Changes the signed-in person\'s email, which they sign in with. Needs a sign-in or auth.reauth from the last 15 minutes (FORBIDDEN details.reason "reauth" otherwise). CONFLICT with details.field "email" when another account uses it. When the panel has an SMTP channel the old address is told (oldAddressNotified). Browser sessions only.',
  input: Type.Object({ email: Email }),
  output: Type.Object({
    viewer: Viewer,
    /** True when an email about the change went to the old address. */
    oldAddressNotified: Type.Boolean(),
  }),
  permission: permission.signedIn(),
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

/** Projects the person hid from their sidebar and home page (added in 0.2.1). */
export const HiddenProjectIds = Type.Array(Id, {
  maxItems: 200,
  uniqueItems: true,
  description:
    "Projects hidden from this person's sidebar and home page, by id. Only projects the person can see are kept; deleted projects drop out. The project pages, links and search still show them.",
});

/**
 * Whether the sidebar ends with the folded "Hidden (N)" group. On by
 * default: only false is stored, and a missing key means on.
 */
export const ShowHiddenInSidebar = Type.Boolean({
  description:
    'Whether this person\'s sidebar shows the folded "Hidden (N)" group of hidden projects. Missing means true (the default); only false is stored. Hidden projects still show on the home page under "Show hidden", in search and at their links either way.',
});

/**
 * Main navigation items a person can take out of their sidebar. Settings is
 * not one of them: it holds the switches that bring the others back.
 */
export const sidebarItems = ["dashboard", "nodes", "templates", "activity", "approvals"] as const;
export type SidebarItemName = (typeof sidebarItems)[number];
export const SidebarItem = Type.Union(sidebarItems.map((item) => Type.Literal(item)));

/** The sidebar items the person turned off; missing means none (every item shows). */
export const HiddenSidebarItems = Type.Array(SidebarItem, {
  uniqueItems: true,
  description:
    "Main navigation items this person took out of their sidebar. Missing means none: every item shows. Settings never hides, and Approvals still shows while a request waits for the person. The pages still open at their links and from search.",
});

/** Keys without a shape of their own stay free-form, as before 0.2.1. */
const AnyKeys = Type.Record(Type.String(), Type.Unknown());

export const Preferences = Type.Intersect(
  [
    Type.Object({
      hiddenProjectIds: Type.Optional(HiddenProjectIds),
      showHiddenInSidebar: Type.Optional(ShowHiddenInSidebar),
      hiddenSidebarItems: Type.Optional(HiddenSidebarItems),
    }),
    AnyKeys,
  ],
  {
    description:
      "Per-person UI choices that follow them across browsers, for example hidden projects or color mode. Keys not listed here are free-form.",
  },
);

/** What auth.updatePreferences takes: the same keys, each of them null to remove it. */
const PreferencesChange = Type.Intersect(
  [
    Type.Object({
      hiddenProjectIds: Type.Optional(
        Type.Union([HiddenProjectIds, Type.Null()], { errorMessage: "must be a list of distinct project ids (at most 200), or null" }),
      ),
      showHiddenInSidebar: Type.Optional(Type.Union([ShowHiddenInSidebar, Type.Null()], { errorMessage: "must be true, false or null" })),
      // Any short name is taken, so a web app that knows an item this panel does not still saves; the panel keeps only sidebarItems.
      hiddenSidebarItems: Type.Optional(
        Type.Union(
          [
            Type.Array(Type.String({ minLength: 1, maxLength: 40 }), {
              maxItems: 32,
              uniqueItems: true,
              description:
                "Names of main navigation items to take out of the sidebar. Names the panel does not know (settings among them) are dropped.",
            }),
            Type.Null(),
          ],
          { errorMessage: "must be a list of distinct sidebar item names (at most 32), or null" },
        ),
      ),
    }),
    AnyKeys,
  ],
  { description: "The keys to change; a key set to null is removed." },
);

export const preferences = defineOp({
  id: "auth.preferences",
  kind: "query",
  summary: "Get your UI preferences",
  description:
    "Returns the signed-in person's UI preferences (hidden projects, whether the sidebar shows them, the sidebar items they turned off, color mode and similar).",
  input: Empty,
  output: Type.Object({ preferences: Preferences }),
  permission: permission.account(),
  mcp: false,
  audit: false,
});

export const updatePreferences = defineOp({
  id: "auth.updatePreferences",
  kind: "mutation",
  summary: "Change your UI preferences",
  description:
    "Merges the given keys into the signed-in person's preferences; a key set to null is removed. hiddenProjectIds keeps only projects the person can see. showHiddenInSidebar is kept only when false (true is the default). hiddenSidebarItems keeps only names the panel knows, and an empty list removes the key. At most 16 KB in total.",
  input: Type.Object({ preferences: PreferencesChange }),
  output: Type.Object({ preferences: Preferences }),
  permission: permission.account(),
  mcp: false,
  audit: true,
});

// ---------------------------------------------------------------------------
// Sessions

export const Session = Type.Object({
  id: Id,
  /** True for the session that made this request. */
  current: Type.Boolean(),
  ip: Type.Union([Type.String(), Type.Null()]),
  userAgent: Type.Union([Type.String(), Type.Null()]),
  createdAt: Timestamp,
  lastSeenAt: Timestamp,
  expiresAt: Timestamp,
});

export const listSessions = defineOp({
  id: "auth.listSessions",
  kind: "query",
  summary: "List your sessions",
  description: "Lists the signed-in person's browser sessions, newest activity first, marking the current one.",
  input: Empty,
  output: Type.Object({ sessions: Type.Array(Session) }),
  permission: permission.signedIn(),
  mcp: false,
  audit: false,
});

export const revokeSession = defineOp({
  id: "auth.revokeSession",
  kind: "mutation",
  summary: "Sign out one session",
  description: "Ends one of your own sessions, for example a browser you no longer use. Ending the current one is the same as signing out.",
  input: Type.Object({ sessionId: Id }),
  output: Empty,
  permission: permission.signedIn(),
  mcp: false,
  audit: true,
});

export const revokeOtherSessions = defineOp({
  id: "auth.revokeOtherSessions",
  kind: "mutation",
  summary: "Sign out everywhere else",
  description: "Ends every session of the signed-in person except the current one.",
  input: Empty,
  output: Type.Object({ revoked: Type.Integer({ minimum: 0 }) }),
  permission: permission.signedIn(),
  mcp: false,
  audit: true,
});

// ---------------------------------------------------------------------------
// Password and second factors

export const security = defineOp({
  id: "auth.security",
  kind: "query",
  summary: "Get your sign-in methods",
  description:
    "Returns how the signed-in person can sign in: password, authenticator app (TOTP), recovery codes left, passkeys and a linked GitHub login.",
  input: Empty,
  output: Type.Object({
    passwordSet: Type.Boolean(),
    totp: Type.Object({
      enabled: Type.Boolean(),
      confirmedAt: Type.Union([Timestamp, Type.Null()]),
    }),
    recoveryCodesLeft: Type.Integer({ minimum: 0 }),
    passkeys: Type.Array(
      Type.Object({
        id: Id,
        name: Type.String(),
        createdAt: Timestamp,
        lastUsedAt: Type.Union([Timestamp, Type.Null()]),
      }),
    ),
    /** Passkeys need a panel domain (WebAuthn does not work on a bare IP). */
    passkeysAvailable: Type.Boolean(),
    github: Type.Union([
      Type.Object({
        login: Type.String(),
        repoAccess: Type.Boolean(),
        linkedAt: Timestamp,
      }),
      Type.Null(),
    ]),
    /** False while the GitHub OAuth client id is still a placeholder. */
    githubAvailable: Type.Boolean(),
  }),
  permission: permission.account(),
  mcp: false,
  audit: false,
});

export const changePassword = defineOp({
  id: "auth.changePassword",
  kind: "mutation",
  summary: "Change your password",
  description:
    "Sets a new password. currentPassword is required when the account has one; without one (people who only used GitHub) a first password needs a sign-in or auth.reauth from the last 15 minutes. Ends every other session.",
  input: Type.Object({
    currentPassword: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    newPassword: NewPassword,
  }),
  output: Type.Object({ revokedSessions: Type.Integer({ minimum: 0 }) }),
  permission: permission.signedIn(),
  sensitive: { input: ["currentPassword", "newPassword"] },
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

export const totpEnroll = defineOp({
  id: "auth.totpEnroll",
  kind: "mutation",
  summary: "Start setting up an authenticator app",
  description:
    'Creates a new TOTP secret for the signed-in person and returns it as a QR-ready otpauth URL. It is not enforced until auth.totpConfirm. CONFLICT when 2FA is already on. Needs a sign-in or auth.reauth from the last 15 minutes (FORBIDDEN details.reason "reauth" otherwise).',
  input: Empty,
  output: Type.Object({
    /** Base32 secret for manual entry. */
    secret: Type.String(),
    /** otpauth://totp/... for the QR code. */
    otpauthUrl: Type.String(),
  }),
  permission: permission.signedIn(),
  sensitive: { output: ["secret", "otpauthUrl"] },
  mcp: false,
  audit: true,
});

export const totpConfirm = defineOp({
  id: "auth.totpConfirm",
  kind: "mutation",
  summary: "Turn on the authenticator app",
  description:
    "Checks a code from the newly enrolled authenticator, turns 2FA on and returns 10 recovery codes. They are shown once; store them somewhere safe.",
  input: Type.Object({ code: Type.String({ pattern: "^[0-9]{6}$" }) }),
  output: Type.Object({ recoveryCodes: Type.Array(Type.String()) }),
  permission: permission.signedIn(),
  sensitive: { input: ["code"], output: ["recoveryCodes"] },
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

export const totpDisable = defineOp({
  id: "auth.totpDisable",
  kind: "mutation",
  summary: "Turn off the authenticator app",
  description: "Turns 2FA off and deletes the recovery codes. Needs a current authenticator code or an unused recovery code.",
  input: Type.Object({ code: Type.String({ minLength: 6, maxLength: 32 }) }),
  output: Empty,
  permission: permission.signedIn(),
  sensitive: { input: ["code"] },
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

export const regenerateRecoveryCodes = defineOp({
  id: "auth.regenerateRecoveryCodes",
  kind: "mutation",
  summary: "Get new recovery codes",
  description: "Replaces every recovery code with 10 new ones, shown once. Needs a current authenticator code. Only while 2FA is on.",
  input: Type.Object({ code: Type.String({ pattern: "^[0-9]{6}$" }) }),
  output: Type.Object({ recoveryCodes: Type.Array(Type.String()) }),
  permission: permission.signedIn(),
  sensitive: { input: ["code"], output: ["recoveryCodes"] },
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

// ---------------------------------------------------------------------------
// Re-auth ("confirm it's you"). Ops that add a way into the account
// (auth.passkeyRegisterBegin, auth.githubLinkStart, auth.totpEnroll,
// apiKeys.create, cliLogin.approve, a first password) and auth.changeEmail
// need a sign-in or a re-auth from the last 15 minutes. Otherwise they fail with FORBIDDEN and
// details.reason "reauth"; the client confirms here (auth.reauth, or the
// linked GitHub login through auth.reauthGithubStart and Poll) and retries.

export const reauth = defineOp({
  id: "auth.reauth",
  kind: "mutation",
  summary: "Confirm it's you",
  description:
    'Confirms the signed-in person with exactly one of: the password, a code (6-digit authenticator code or an unused recovery code, which is used up), or a passkey assertion for the ticket from auth.reauthPasskeyBegin. The session then counts as freshly signed in for 15 minutes. A wrong answer is BAD_REQUEST with details.field "password", "code" or "passkey". A linked GitHub login confirms through auth.reauthGithubStart instead. Browser sessions only.',
  input: Type.Object({
    password: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    code: Type.Optional(Type.String({ minLength: 6, maxLength: 32 })),
    passkey: Type.Optional(Type.Object({ ticket: Ticket, response: WebAuthnJson })),
  }),
  output: Type.Object({
    /** Until then ops that add a way in work without asking again. */
    freshUntil: Timestamp,
  }),
  permission: permission.signedIn(),
  sensitive: { input: ["password", "code", "passkey"] },
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

export const reauthPasskeyBegin = defineOp({
  id: "auth.reauthPasskeyBegin",
  kind: "mutation",
  summary: "Start confirming it's you with a passkey",
  description:
    "Returns WebAuthn request options for navigator.credentials.get, limited to the signed-in person's passkeys, and a ticket for auth.reauth. UNAVAILABLE without a panel domain, CONFLICT when the account has no passkey.",
  input: Empty,
  output: Type.Object({ ticket: Type.String(), options: WebAuthnJson }),
  permission: permission.signedIn(),
  sensitive: { output: ["ticket"] },
  mcp: false,
  audit: true,
});

export const reauthGithubStart = defineOp({
  id: "auth.reauthGithubStart",
  kind: "mutation",
  summary: "Start confirming it's you with GitHub",
  description:
    "Starts the GitHub device flow to confirm the signed-in person with the GitHub login linked to their account, for accounts that sign in with GitHub. Show userCode, open verificationUri, then call auth.reauthGithubPoll every intervalSeconds. CONFLICT when the account has no linked GitHub login, UNAVAILABLE while the OAuth client id is a placeholder. Browser sessions only.",
  input: Empty,
  output: DeviceCode,
  permission: permission.signedIn(),
  sensitive: { output: ["ticket"] },
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

export const reauthGithubPoll = defineOp({
  id: "auth.reauthGithubPoll",
  kind: "mutation",
  summary: "Check a GitHub confirmation",
  description:
    'Polls the device flow started by auth.reauthGithubStart. With status done GitHub approved it as the login linked to this account, and the session counts as freshly signed in for 15 minutes (freshUntil), as after auth.reauth. Approving as another GitHub login is BAD_REQUEST with details.field "github" and counts toward the per-address lock; an unknown, used or expired ticket is BAD_REQUEST. Browser sessions only.',
  input: Type.Object({ ticket: Ticket }),
  output: Type.Object({
    status: DevicePollStatus,
    intervalSeconds: Type.Integer({ minimum: 1 }),
    /** With status done: until then ops that add a way in work without asking again. */
    freshUntil: Type.Optional(Timestamp),
  }),
  permission: permission.signedIn(),
  sensitive: { input: ["ticket"] },
  rateLimit: "standard",
  mcp: false,
  audit: true,
});

// ---------------------------------------------------------------------------
// Passkeys (WebAuthn). Only offered once the panel has a domain.

export const passkeyRegisterBegin = defineOp({
  id: "auth.passkeyRegisterBegin",
  kind: "mutation",
  summary: "Start adding a passkey",
  description:
    'Returns WebAuthn creation options for navigator.credentials.create and a ticket for auth.passkeyRegisterFinish. Needs a sign-in or auth.reauth from the last 15 minutes (FORBIDDEN details.reason "reauth" otherwise).',
  input: Empty,
  output: Type.Object({ ticket: Type.String(), options: WebAuthnJson }),
  permission: permission.signedIn(),
  sensitive: { output: ["ticket"] },
  mcp: false,
  audit: true,
});

export const passkeyRegisterFinish = defineOp({
  id: "auth.passkeyRegisterFinish",
  kind: "mutation",
  summary: "Save a new passkey",
  description: "Verifies the authenticator's registration response and stores the passkey under the given name.",
  input: Type.Object({
    ticket: Ticket,
    name: Type.String({ minLength: 1, maxLength: 60 }),
    response: WebAuthnJson,
  }),
  output: Type.Object({ id: Id, name: Type.String(), createdAt: Timestamp }),
  permission: permission.signedIn(),
  sensitive: { input: ["ticket", "response"] },
  mcp: false,
  audit: true,
});

export const passkeyRemove = defineOp({
  id: "auth.passkeyRemove",
  kind: "mutation",
  summary: "Remove a passkey",
  description: "Deletes one of your own passkeys. That device can no longer sign in.",
  input: Type.Object({ passkeyId: Id }),
  output: Empty,
  permission: permission.signedIn(),
  mcp: false,
  audit: true,
});

export const passkeyLoginBegin = defineOp({
  id: "auth.passkeyLoginBegin",
  kind: "mutation",
  summary: "Start signing in with a passkey",
  description: "Returns WebAuthn request options for navigator.credentials.get (discoverable credentials, no email needed) and a ticket.",
  input: Empty,
  output: Type.Object({ ticket: Type.String(), options: WebAuthnJson }),
  permission: permission.public(),
  sensitive: { output: ["ticket"] },
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

export const passkeyLoginFinish = defineOp({
  id: "auth.passkeyLoginFinish",
  kind: "mutation",
  summary: "Sign in with a passkey",
  description: "Verifies the passkey assertion and starts a session. A passkey counts as both factors, so 2FA is not asked again.",
  input: Type.Object({ ticket: Ticket, response: WebAuthnJson }),
  output: LoginResult,
  permission: permission.public(),
  sensitive: { input: ["ticket", "response"], output: ["challenge.ticket"] },
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

// ---------------------------------------------------------------------------
// GitHub device flow: sign in, link, unlink

export const githubStart = defineOp({
  id: "auth.githubStart",
  kind: "mutation",
  summary: "Start signing in with GitHub",
  description:
    "Starts the GitHub device flow for sign-in. Show userCode, open verificationUri, then call auth.githubPoll every intervalSeconds. UNAVAILABLE while the OAuth client id is a placeholder.",
  input: Empty,
  output: DeviceCode,
  permission: permission.public(),
  sensitive: { output: ["ticket"] },
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

export const githubPoll = defineOp({
  id: "auth.githubPoll",
  kind: "mutation",
  summary: "Check a GitHub sign-in",
  description:
    "Polls the device flow. With status done it signs in the person linked to that GitHub login (result holds the LoginResult); noAccount when nobody is linked to it.",
  input: Type.Object({ ticket: Ticket }),
  output: Type.Object({
    status: Type.Union([DevicePollStatus, Type.Literal("noAccount")]),
    intervalSeconds: Type.Integer({ minimum: 1 }),
    result: Type.Optional(LoginResult),
  }),
  permission: permission.public(),
  sensitive: { input: ["ticket"], output: ["result.challenge.ticket"] },
  mcp: false,
  audit: true,
});

export const githubLinkStart = defineOp({
  id: "auth.githubLinkStart",
  kind: "mutation",
  summary: "Start linking your GitHub login",
  description:
    'Starts the device flow to link a GitHub login to the signed-in person, so they can sign in with GitHub later. Needs a sign-in or auth.reauth from the last 15 minutes (FORBIDDEN details.reason "reauth" otherwise).',
  input: Type.Object({ repoAccess: RepoAccess }),
  output: DeviceCode,
  permission: permission.signedIn(),
  sensitive: { output: ["ticket"] },
  mcp: false,
  audit: true,
});

export const githubLinkPoll = defineOp({
  id: "auth.githubLinkPoll",
  kind: "mutation",
  summary: "Check a GitHub link",
  description:
    "Polls the device flow started by auth.githubLinkStart. With status done the GitHub login is linked. CONFLICT when that login belongs to someone else.",
  input: Type.Object({ ticket: Ticket }),
  output: Type.Object({
    status: DevicePollStatus,
    intervalSeconds: Type.Integer({ minimum: 1 }),
    login: Type.Optional(Type.String()),
  }),
  permission: permission.signedIn(),
  sensitive: { input: ["ticket"] },
  mcp: false,
  audit: true,
});

export const githubUnlink = defineOp({
  id: "auth.githubUnlink",
  kind: "mutation",
  summary: "Unlink your GitHub login",
  description: "Removes the linked GitHub login and its stored token. Fails when it is the only way this account can sign in.",
  input: Empty,
  output: Empty,
  permission: permission.signedIn(),
  mcp: false,
  audit: true,
});
