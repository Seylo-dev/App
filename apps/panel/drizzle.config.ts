// drizzle-kit config for panel.db. `bun run db:generate` writes a new SQL
// migration to drizzle/ after a schema change; commit it with the change.

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle/panel",
});
