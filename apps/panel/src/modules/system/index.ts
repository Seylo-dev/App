// Panel-wide information for the dashboard and sidebar: info, version and
// which optional features are on.

import { defineModule } from "../module";
import { features } from "./features";
import { info } from "./info";
import { version } from "./version";

export default defineModule({ name: "system", ops: [info, version, features] });
