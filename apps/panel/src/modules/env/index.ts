// Env: a service's .env text and the project's shared variables (sealed at
// rest), the References list and diagnostics from @seylo/env-analyzer.
// desired.ts resolves the final environment for the desired state.

import { defineModule } from "../module";
import { analyze, get, getShared, references, set, setShared } from "./ops";

export default defineModule({ name: "env", ops: [get, set, references, analyze, getShared, setShared] });
