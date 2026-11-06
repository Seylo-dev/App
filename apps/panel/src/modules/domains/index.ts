// Domains: automatic domains from a node's wildcard record, custom domains
// with a DNS check and the Cloudflare DNS link, paths, HTTPS, custom
// certificates and per-domain middlewares. desired.ts turns them into
// ServiceSpec.routing (contributor.ts hands every networking part of the desired
// state to the compiler); tracking.ts follows the agents' route reports.

import { defineModule } from "../module";
import { networkingContributor } from "./contributor";
import { add, addAuto, checkDns, list, remove, setCertificate, setMiddlewares, setPrimary, update } from "./ops";
import { trackRoutes } from "./tracking";

export default defineModule({
  name: "domains",
  ops: [list, addAuto, add, checkDns, update, setMiddlewares, setCertificate, setPrimary, remove],
  start: (deps) => {
    trackRoutes(deps);
    deps.agents.desired.contribute(networkingContributor);
  },
});
