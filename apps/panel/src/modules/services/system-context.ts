// An OpContext for work the panel does on its own (webhooks, jobs), so it
// can reuse other modules' op handlers as functions. Permission checks
// happened earlier (or the panel itself is acting); the principal is
// anonymous, so nothing is attributed to a person.

import { createAccess } from "../../auth/access";
import { anonymous } from "../../auth/principal";
import type { Deps } from "../../deps";
import type { OpContext } from "../../ops/implement";

export function systemContext(deps: Deps): OpContext {
  return { ...deps, principal: anonymous, access: createAccess(deps.db, anonymous), http: null, ip: null, userAgent: null };
}
