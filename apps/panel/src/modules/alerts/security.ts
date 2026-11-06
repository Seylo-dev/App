// security_change alerts: something that lets a person, or a program acting
// as them, into the panel was added or weakened (a CLI sign-in approved, an
// API key created, a passkey or GitHub sign-in added, a password changed,
// two-factor sign-in turned off). One alert per change, so a stolen session
// that mints itself a key is noticed on the channels the owner reads.

import type { PrincipalUser } from "../../auth/principal";
import type { OpContext } from "../../ops/implement";

export function raiseSecurityChange(
  ctx: Pick<OpContext, "alerts" | "ip">,
  user: Pick<PrincipalUser, "id" | "email" | "name">,
  what: string,
  details?: string,
): void {
  const who = user.name || user.email;
  const from = ctx.ip ? ` From ${ctx.ip}.` : "";
  ctx.alerts.raise({
    event: "security_change",
    key: `security:${user.id}:${Date.now()}:${crypto.randomUUID()}`,
    title: `${who}: ${what}`,
    message: `${details ? `${details} ` : ""}If this was not ${who}, revoke it in Settings and change the password.${from}`,
    link: "/settings/security",
  });
}
