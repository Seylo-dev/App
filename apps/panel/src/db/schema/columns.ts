// Column helpers shared by every table so ids and timestamps look the same
// everywhere. Timestamps are integer milliseconds since the Unix epoch.

import { integer, text } from "drizzle-orm/sqlite-core";
import { newId } from "../../ids";

export const id = () => text("id").primaryKey().$defaultFn(newId);

export const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

export const createdAt = () =>
  timestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date());

export const updatedAt = () =>
  timestamp("updated_at")
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

/** JSON stored as text. Never use it for secrets: seal those (security/secret-box.ts). */
export const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

/** A value sealed with the master key; see security/secret-box.ts for purposes. */
export const sealed = (name: string) => text(name);
