// Templates people added to this panel. The built-in catalog ships as files
// in templates/ (Easypanel's format: meta.yaml + index.ts generate()) and
// is not stored here. Template code only ever runs in the QuickJS sandbox.

import { sql } from "drizzle-orm";
import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, json, updatedAt } from "./columns";
import { users } from "./identity";

export const customTemplates = sqliteTable(
  "custom_templates",
  {
    id: id(),
    /** Unique among custom templates; may shadow nothing in the built-in catalog. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default("Other"),
    /** Parsed meta.yaml (form fields, tags, links). */
    meta: json<Record<string, unknown>>("meta").notNull().default(sql`'{}'`),
    /** index.ts source with the generate() function. */
    source: text("source").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("custom_templates_slug_unique").on(t.slug)],
);
