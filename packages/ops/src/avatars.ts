// Avatars every person has: a generated face (a DiceBear style and a seed,
// drawn by the panel, never fetched from api.dicebear.com) or an image they
// uploaded. Shared by the avatars ops (src/ops/avatars.ts), the people
// schemas (people.ts) and the web app's picker. They live outside src/ops/
// because every file there is an op module.

import { Type } from "@sinclair/typebox";

/**
 * The styles people can pick. Only styles whose artwork license allows use
 * in an AGPL project are listed: CC0 1.0 (public domain) and CC BY 4.0
 * (credit the creator, here and in NOTICE). DiceBear's Avataaars and Bottts
 * ("free for personal and commercial use", no right to modify or
 * redistribute stated) are left out. The panel test checks each entry
 * against the license the DiceBear package itself declares.
 */
export const avatarStyles = [
  {
    id: "notionists",
    label: "Notionists",
    work: "Notionists",
    creator: "Zoish",
    source: "https://heyzoish.gumroad.com/l/notionists",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  },
  {
    id: "adventurer",
    label: "Adventurer",
    work: "Adventurer",
    creator: "Lisa Wischofsky",
    source: "https://www.figma.com/community/file/1184595184137881796",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  },
  {
    id: "big-smile",
    label: "Big Smile",
    work: "Custom Avatar",
    creator: "Ashley Seo",
    source: "https://www.figma.com/community/file/881358461963645496",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  },
  {
    id: "fun-emoji",
    label: "Fun Emoji",
    work: "Fun Emoji Set",
    creator: "Davis Uche",
    source: "https://www.figma.com/community/file/968125295144990435",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  },
  {
    id: "lorelei",
    label: "Lorelei",
    work: "Lorelei",
    creator: "Lisa Wischofsky",
    source: "https://www.figma.com/community/file/1198749693280469639",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  },
  {
    id: "micah",
    label: "Micah",
    work: "Avatar Illustration System",
    creator: "Micah Lanier",
    source: "https://www.figma.com/community/file/829741575478342595",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  },
  {
    id: "open-peeps",
    label: "Open Peeps",
    work: "Open Peeps",
    creator: "Pablo Stanley",
    source: "https://www.openpeeps.com/",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  },
  {
    id: "personas",
    label: "Personas",
    work: "Personas by Draftbit",
    creator: "Draftbit",
    source: "https://personas.draftbit.com/",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  },
  {
    id: "pixel-art",
    label: "Pixel Art",
    work: "Pixel Art",
    creator: "DiceBear",
    source: "https://www.figma.com/community/file/1198754108850888330",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  },
  {
    id: "thumbs",
    label: "Thumbs",
    work: "Thumbs",
    creator: "DiceBear",
    source: "https://www.dicebear.com",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  },
] as const;

export type AvatarStyleId = (typeof avatarStyles)[number]["id"];
export type AvatarStyleInfo = (typeof avatarStyles)[number];

/** New people get a face in this style with a random seed. */
export const defaultAvatarStyle: AvatarStyleId = "notionists";

export const avatarStyleIds: readonly AvatarStyleId[] = avatarStyles.map((style) => style.id);

export function isAvatarStyle(value: string): value is AvatarStyleId {
  return (avatarStyleIds as readonly string[]).includes(value);
}

export const AvatarStyle = Type.Union(
  avatarStyles.map((style) => Type.Literal(style.id)),
  { description: "A generated avatar style (see avatarStyles for the list and each style's license)." },
);

/** Seeds are short: letters, digits, - and _. Same style and seed, same face. */
export const avatarSeedPattern = "^[A-Za-z0-9_-]{1,64}$";
const seedRegExp = new RegExp(avatarSeedPattern);

export function isAvatarSeed(value: string): boolean {
  return seedRegExp.test(value);
}

export const AvatarSeed = Type.String({ pattern: avatarSeedPattern, description: "Letters, digits, - and _ (1 to 64)." });

const seedAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A random seed of 10 letters and digits, from the platform's crypto (browser and Bun). */
export function randomAvatarSeed(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (byte) => seedAlphabet[byte % seedAlphabet.length]).join("");
}

/** Where every avatar is served (apps/panel/src/modules/avatars/http.ts). */
export const avatarPathPrefix = "/api/avatars";

/** A generated face: public and the same for everyone, so it caches for a year. */
export function presetAvatarPath(style: AvatarStyleId, seed: string): string {
  return `${avatarPathPrefix}/${style}/${encodeURIComponent(seed)}.svg`;
}

/** An uploaded image; the version is its content hash, so a new upload is a new URL. */
export function uploadedAvatarPath(userId: string, hash: string): string {
  return `${avatarPathPrefix}/user/${userId}?v=${hash}`;
}

/** Images people may upload. Never SVG: an uploaded SVG could carry script. */
export const avatarUploadTypes = ["image/png", "image/jpeg", "image/webp"] as const;
export type AvatarUploadType = (typeof avatarUploadTypes)[number];

/** The web app crops to a square and scales to this many pixels before it uploads. */
export const avatarPixels = 256;

/** Largest upload after that, in bytes. */
export const avatarMaxBytes = 1024 * 1024;

export const AvatarUrl = Type.String({
  maxLength: 200,
  description: `Path of the person's avatar image on the panel (${avatarPathPrefix}/...); show initials when it fails to load.`,
});
