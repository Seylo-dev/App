// Boxes: code-server workspaces as services with a persistent home volume,
// opened through the node's edge with a signed one-time link, sleeping when
// idle. desired.ts gives the compiler the BoxSpec.

import { defineModule } from "../module";
import { create, get, open, stop } from "./ops";

export default defineModule({ name: "boxes", ops: [create, get, open, stop] });
