// @seylo/ops: the operation registry. Import contracts by module
// (`import { projects } from "@seylo/ops"` then `projects.create`) or the
// whole list (`allOps`). Server-only and React-only helpers have their own
// entry points: @seylo/ops/elysia, @seylo/ops/react, @seylo/ops/client.

import "./formats";
import { opModules } from "./ops/index.gen";
import { collectOps } from "./registry";

export * from "./actions";
export * from "./define";
export * from "./errors";
export { registeredFormats } from "./formats";
export * from "./lint";
export * from "./live";
export * from "./ops/index.gen";
export * from "./people";
export * from "./permission";
export * from "./redact";
export * from "./registry";
export * from "./schemas";

/** Every op contract, sorted by id. */
export const allOps = collectOps(opModules);
