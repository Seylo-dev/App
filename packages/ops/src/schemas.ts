// Schemas shared by several op modules. Module-specific shapes stay in
// their own file under src/ops/.

import { Type } from "@sinclair/typebox";

/** Panel-issued id: lowercase letters and digits, safe in paths and Docker names. */
export const Id = Type.String({ pattern: "^[a-z0-9]{16}$", description: "Panel-issued id." });

/** RFC 3339 timestamp in UTC. Ops return strings, never Date objects. */
export const Timestamp = Type.String({ format: "date-time" });

/** An empty object, for ops that take no input or return nothing. */
export const Empty = Type.Object({});
