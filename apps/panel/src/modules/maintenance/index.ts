// Maintenance: the global and per-service maintenance and down pages.
// page.ts renders what visitors get; domains/desired.ts sends it to the
// nodes (Routing.maintenance, Routing.status_page, NodeSettings.maintenance).

import { defineModule } from "../module";
import { get, getGlobal, preview, set, setGlobal } from "./ops";
import "./settings";

export default defineModule({ name: "maintenance", ops: [getGlobal, setGlobal, get, set, preview] });
