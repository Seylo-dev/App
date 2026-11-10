// A person's avatar as stored on users.avatar and as screens get it: every
// way to create an account gives a random generated face (setup, invites,
// create-owner), and outputs carry the image's path as avatarUrl. The
// images themselves are served by modules/avatars/http.ts.

import { defaultAvatarStyle, isAvatarStyle, presetAvatarPath, randomAvatarSeed, uploadedAvatarPath } from "@seylo/ops";
import { eq, inArray, isNull } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { type StoredAvatar, users } from "../db/schema";

/** A face in the default style with a random seed, for a new account. */
export function randomPresetAvatar(): StoredAvatar {
  return { kind: "preset", style: defaultAvatarStyle, seed: randomAvatarSeed() };
}

/** The generated face's path; a style no longer offered draws the same seed in the default style. */
export function presetUrlOf(avatar: Pick<StoredAvatar, "style" | "seed">): string {
  return presetAvatarPath(isAvatarStyle(avatar.style) ? avatar.style : defaultAvatarStyle, avatar.seed);
}

/** The path of the image to show, or undefined for an account that has no avatar yet. */
export function avatarUrlOf(userId: string, avatar: StoredAvatar | null | undefined): string | undefined {
  if (!avatar) return undefined;
  return avatar.kind === "upload" ? uploadedAvatarPath(userId, avatar.hash) : presetUrlOf(avatar);
}

/** `{ avatarUrl }` for an output, or nothing: the field is optional and never sent as undefined. */
export function avatarField(userId: string, avatar: StoredAvatar | null | undefined): { avatarUrl?: string } {
  const url = avatarUrlOf(userId, avatar);
  return url ? { avatarUrl: url } : {};
}

/** Avatar paths of several people at once (audit entries, approvals, grants), by user id. */
export function avatarUrlsOf(db: PanelDb, userIds: readonly (string | null | undefined)[]): Map<string, string> {
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === "string"))];
  if (ids.length === 0) return new Map();
  const rows = db.select({ id: users.id, avatar: users.avatar }).from(users).where(inArray(users.id, ids)).all();
  const urls = new Map<string, string>();
  for (const row of rows) {
    const url = avatarUrlOf(row.id, row.avatar);
    if (url) urls.set(row.id, url);
  }
  return urls;
}

/**
 * Gives every account without an avatar a random face, once: accounts from
 * before avatars, and rows a script or an old panel inserted. The panel
 * runs it at start; returns how many it filled.
 */
export function assignMissingAvatars(db: PanelDb): number {
  return db.transaction((tx) => {
    const missing = tx.select({ id: users.id }).from(users).where(isNull(users.avatar)).all();
    for (const row of missing) {
      tx.update(users).set({ avatar: randomPresetAvatar() }).where(eq(users.id, row.id)).run();
    }
    return missing.length;
  });
}
