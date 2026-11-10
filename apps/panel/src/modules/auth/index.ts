// Sign-in, sessions and the signed-in person's own security settings.
// Contracts: packages/ops/src/ops/auth.ts. Shared building blocks live in
// src/auth/ (sessions, challenges, second factor, GitHub device flow,
// passkey relying party).

import { defineModule } from "../module";
import { changeEmail } from "./email";
import { githubLinkPoll, githubLinkStart, githubPoll, githubStart, githubUnlink } from "./github";
import { login, verifySecondFactor } from "./login";
import { logout } from "./logout";
import { passkeyLoginBegin, passkeyLoginFinish, passkeyRegisterBegin, passkeyRegisterFinish, passkeyRemove } from "./passkeys";
import { preferences, updatePreferences, updateProfile } from "./profile";
import { reauth, reauthGithubPoll, reauthGithubStart, reauthPasskeyBegin } from "./reauth";
import { changePassword, regenerateRecoveryCodes, security, totpConfirm, totpDisable, totpEnroll } from "./security";
import { listSessions, revokeOtherSessions, revokeSession } from "./sessions";
import { whoami } from "./whoami";

export default defineModule({
  name: "auth",
  ops: [
    login,
    verifySecondFactor,
    logout,
    whoami,
    updateProfile,
    changeEmail,
    preferences,
    updatePreferences,
    listSessions,
    revokeSession,
    revokeOtherSessions,
    security,
    changePassword,
    totpEnroll,
    totpConfirm,
    totpDisable,
    regenerateRecoveryCodes,
    reauth,
    reauthPasskeyBegin,
    reauthGithubStart,
    reauthGithubPoll,
    passkeyRegisterBegin,
    passkeyRegisterFinish,
    passkeyRemove,
    passkeyLoginBegin,
    passkeyLoginFinish,
    githubStart,
    githubPoll,
    githubLinkStart,
    githubLinkPoll,
    githubUnlink,
  ],
});
