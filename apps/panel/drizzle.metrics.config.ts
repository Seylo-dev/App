// drizzle-kit config for metrics.db (see drizzle.config.ts).

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/metrics/schema.ts",
  out: "./drizzle/metrics",
});
