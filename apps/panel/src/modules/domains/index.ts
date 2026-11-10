// Domains: automatic domains from a node's wildcard record, custom domains
// with a DNS check and the Cloudflare DNS link, paths, HTTPS, custom
// certificates, regenerating a Let's Encrypt certificate
// (certificate-retry.ts), the origin check that tells whether a domain
// behind Cloudflare's proxy reaches the node (origin.ts) and per-domain
// middlewares. desired.ts turns them into
// ServiceSpec.routing (contributor.ts hands every networking part of the desired
// state to the compiler); tracking.ts follows the agents' route reports.

import { defineModule } from "../module";
import { retryCertificate } from "./certificate-retry";
import { networkingContributor } from "./contributor";
import { add, addAuto, checkDns, list, remove, setCertificate, setMiddlewares, setPrimary, update } from "./ops";
import { originCheckJob } from "./origin";
import { trackRoutes } from "./tracking";

export default defineModule({
  name: "domains",
  ops: [list, addAuto, add, checkDns, update, setMiddlewares, setCertificate, setPrimary, retryCertificate, remove],
  jobs: [originCheckJob],
  start: (deps) => {
    trackRoutes(deps);
    deps.agents.desired.contribute(networkingContributor);
  },
});
