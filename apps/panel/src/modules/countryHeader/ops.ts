// countryHeader.get and countryHeader.update: the panel-wide switch and the
// MaxMind account. Every node gets the change in its NodeSettings at once.

import { countryHeader, OpError } from "@seylo/ops";
import { asc } from "drizzle-orm";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import { implement } from "../../ops/implement";
import { setSetting } from "../../settings";
import { nodeHasCapability } from "../databases/capability";
import { maxmindKeyPurpose, readCountryHeader } from "./settings";

function view(deps: Pick<Deps, "db" | "agents">) {
  const stored = readCountryHeader(deps.db);
  return {
    enabled: stored.enabled,
    maxmindAccountId: stored.maxmindAccountId,
    maxmindLicenseKeySet: stored.maxmindLicenseKeySealed !== null,
    nodes: deps.db
      .select({ id: nodes.id, name: nodes.name })
      .from(nodes)
      .orderBy(asc(nodes.name))
      .all()
      .map((n) => ({ ...n, supported: nodeHasCapability(deps.db, deps.agents, n.id, countryHeader.countryHeaderCapability) })),
  };
}

export const get = implement(countryHeader.get, (_input, ctx) => view(ctx));

export const update = implement(countryHeader.update, (input, ctx) => {
  const stored = readCountryHeader(ctx.db);
  const accountId = input.maxmindAccountId !== undefined ? input.maxmindAccountId : stored.maxmindAccountId;
  const keySealed =
    input.maxmindLicenseKey === undefined
      ? stored.maxmindLicenseKeySealed
      : input.maxmindLicenseKey === null
        ? null
        : ctx.secrets.seal(input.maxmindLicenseKey, maxmindKeyPurpose);
  if (input.maxmindLicenseKey && !accountId) {
    throw new OpError("BAD_REQUEST", "A MaxMind license key needs the account ID it belongs to.", { field: "maxmindAccountId" });
  }
  setSetting(ctx.db, "countryHeader", {
    enabled: input.enabled ?? stored.enabled,
    maxmindAccountId: accountId,
    maxmindLicenseKeySealed: keySealed,
    updatedAt: Date.now(),
  });
  ctx.agents.desired.markDirty({ all: true });
  ctx.live.publish("panel", { type: "invalidate", ops: ["countryHeader.get"] });
  return view(ctx);
});
