// The visitor country request header (X-Seylo-Country, added in 0.2.24):
// a panel-wide switch, on by default, and a MaxMind account as the second
// source of the country database (settings.ts, ops.ts). Services turn it
// off with services.setCountryHeader (the countryHeader key of their spec).
// The nodes do the rest (the agent's geoip package): the lookup, the
// database, and deleting the header clients send.

import { defineModule } from "../module";
import { countryHeaderContributor } from "./desired";
import { get, update } from "./ops";

export default defineModule({
  name: "countryHeader",
  ops: [get, update],
  start(deps) {
    deps.agents.desired.contribute(countryHeaderContributor);
  },
});
