// Draws generated faces with the DiceBear packages, on the panel: a
// self-hosted panel may have no way out to api.dicebear.com, and the web
// app's CSP would not load it anyway. Only the styles in avatarStyles
// (@seylo/ops) are imported, so the bundle carries no other artwork. Each
// SVG keeps the license metadata DiceBear writes into it.

import { adventurer, bigSmile, funEmoji, lorelei, micah, notionists, openPeeps, personas, pixelArt, thumbs } from "@dicebear/collection";
import { createAvatar, type Style } from "@dicebear/core";
import type { AvatarStyleId } from "@seylo/ops";

/** Each style's own options are left at their defaults: only the seed and the background are passed. */
export const dicebearStyles: Record<AvatarStyleId, Style<object>> = {
  notionists,
  adventurer,
  "big-smile": bigSmile,
  "fun-emoji": funEmoji,
  lorelei,
  micah,
  "open-peeps": openPeeps,
  personas,
  "pixel-art": pixelArt,
  thumbs,
};

/**
 * Soft backgrounds picked by the seed. Most styles are drawn on a
 * transparent ground and some in dark lines, which would vanish on a dark
 * theme; a light disc keeps every face readable on every preset.
 */
export const avatarBackgrounds = ["b6e3f4", "c0aede", "d1d4f9", "ffd5dc", "ffdfbf", "c4ecd8"];

/** Drawn faces kept in memory, newest last; a face is a few KB and lists show the same ones again and again. */
const cacheLimit = 500;
const cache = new Map<string, string>();

/** The SVG for a style and seed. The same input always gives the same face. */
export function renderAvatar(style: AvatarStyleId, seed: string): string {
  const key = `${style}/${seed}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const svg = createAvatar(dicebearStyles[style], { seed, backgroundColor: avatarBackgrounds }).toString();
  cache.set(key, svg);
  if (cache.size > cacheLimit) cache.delete(cache.keys().next().value as string);
  return svg;
}
