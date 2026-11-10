// A person's avatar row: the face (style and seed) on users.avatar and an
// uploaded image's bytes in user_avatars. An upload keeps the face, so
// removing it shows the face again; picking a face drops the upload.

import { createHash } from "node:crypto";
import { type AvatarUploadType, avatarMaxBytes, avatarUploadTypes, defaultAvatarStyle, isAvatarStyle, OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { avatarUrlOf, presetUrlOf, randomPresetAvatar } from "../../auth/avatar";
import type { PanelDb } from "../../db/client";
import { type StoredAvatar, userAvatars, users } from "../../db/schema";

/** The person's avatar; an account without one gets a random face now, saved. */
export function ensureAvatar(db: PanelDb, userId: string): StoredAvatar {
  const row = db.select({ avatar: users.avatar }).from(users).where(eq(users.id, userId)).get();
  if (!row) throw new OpError("NOT_FOUND", "This account no longer exists.");
  if (row.avatar) return row.avatar;
  const avatar = randomPresetAvatar();
  db.update(users).set({ avatar }).where(eq(users.id, userId)).run();
  return avatar;
}

/** The avatar as the ops return it. */
export function toAvatar(userId: string, avatar: StoredAvatar) {
  const style = isAvatarStyle(avatar.style) ? avatar.style : defaultAvatarStyle;
  const presetUrl = presetUrlOf(avatar);
  return { kind: avatar.kind, style, seed: avatar.seed, url: avatarUrlOf(userId, avatar) ?? presetUrl, presetUrl };
}

export function setPreset(db: PanelDb, userId: string, style: string, seed: string): StoredAvatar {
  const avatar: StoredAvatar = { kind: "preset", style, seed };
  db.transaction((tx) => {
    tx.update(users).set({ avatar }).where(eq(users.id, userId)).run();
    tx.delete(userAvatars).where(eq(userAvatars.userId, userId)).run();
  });
  return avatar;
}

export function saveUpload(db: PanelDb, userId: string, image: { bytes: Buffer; contentType: AvatarUploadType }): StoredAvatar {
  const hash = createHash("sha256").update(image.bytes).digest("hex").slice(0, 32);
  return db.transaction((tx) => {
    const face = ensureAvatar(tx as unknown as PanelDb, userId);
    const avatar: StoredAvatar = { kind: "upload", style: face.style, seed: face.seed, hash, contentType: image.contentType };
    tx.insert(userAvatars)
      .values({ userId, contentType: image.contentType, hash, bytes: image.bytes })
      .onConflictDoUpdate({
        target: userAvatars.userId,
        set: { contentType: image.contentType, hash, bytes: image.bytes, createdAt: new Date() },
      })
      .run();
    tx.update(users).set({ avatar }).where(eq(users.id, userId)).run();
    return avatar;
  });
}

export function removeUpload(db: PanelDb, userId: string): StoredAvatar {
  const current = ensureAvatar(db, userId);
  return setPreset(db, userId, current.style, current.seed);
}

/** The first bytes of each allowed type, so a renamed file (an SVG, a page) cannot pose as an image. */
function looksLike(contentType: AvatarUploadType, bytes: Buffer): boolean {
  switch (contentType) {
    case "image/png":
      return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/webp":
      return bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  }
}

/** Reads avatars.upload's data URL: PNG, JPEG or WebP whose bytes say so, at most avatarMaxBytes. */
export function parseAvatarUpload(dataUrl: string): { bytes: Buffer; contentType: AvatarUploadType } {
  const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  const contentType = avatarUploadTypes.find((type) => type === match?.[1]);
  if (!match || !contentType) {
    throw new OpError("BAD_REQUEST", "Upload a PNG, JPEG or WebP image.", { field: "dataUrl" });
  }
  const bytes = Buffer.from(match[2] as string, "base64");
  if (bytes.length === 0) throw new OpError("BAD_REQUEST", "The image is empty.", { field: "dataUrl" });
  if (bytes.length > avatarMaxBytes) throw new OpError("BAD_REQUEST", "The image is larger than 1 MB.", { field: "dataUrl" });
  if (!looksLike(contentType, bytes)) {
    throw new OpError("BAD_REQUEST", `The file is not a ${contentType.slice("image/".length).toUpperCase()} image.`, { field: "dataUrl" });
  }
  return { bytes, contentType };
}
