// Turns a picked photo into what avatars.upload takes: the middle square of
// the image, scaled to avatarPixels on a canvas and encoded as WebP (PNG
// where the browser cannot write WebP). Re-drawing it also drops the
// file's metadata (camera, location) before anything leaves the browser.

import { avatarMaxBytes, avatarPixels, avatarUploadTypes } from "@seylo/ops";

export type AvatarFileProblem = "type" | "tooBig" | "unreadable";

export class AvatarImageError extends Error {
  constructor(readonly problem: AvatarFileProblem) {
    super(problem);
  }
}

/** Types the file picker offers and the panel takes. */
export const avatarAccept = avatarUploadTypes.join(",");

/** Photos straight from a phone are big; anything past this is not worth decoding. */
const maxSourceBytes = 25 * 1024 * 1024;

/** Why a picked file cannot become an avatar, or null when it can. */
export function avatarFileProblem(file: Pick<File, "type" | "size">): AvatarFileProblem | null {
  if (!(avatarUploadTypes as readonly string[]).includes(file.type)) return "type";
  if (file.size > maxSourceBytes) return "tooBig";
  return null;
}

/** The largest centered square of a width x height image: where to cut it from. */
export function centeredSquare(width: number, height: number): { x: number; y: number; size: number } {
  const size = Math.min(width, height);
  return { x: Math.floor((width - size) / 2), y: Math.floor((height - size) / 2), size };
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new AvatarImageError("unreadable"));
    reader.readAsDataURL(blob);
  });
}

/** The square, scaled image as a data URL; throws AvatarImageError with the reason it cannot be used. */
export async function squareAvatar(file: File): Promise<string> {
  const problem = avatarFileProblem(file);
  if (problem) throw new AvatarImageError(problem);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new AvatarImageError("unreadable");
  }
  const canvas = document.createElement("canvas");
  canvas.width = avatarPixels;
  canvas.height = avatarPixels;
  const context = canvas.getContext("2d");
  if (!context) throw new AvatarImageError("unreadable");
  const { x, y, size } = centeredSquare(bitmap.width, bitmap.height);
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, x, y, size, size, 0, 0, avatarPixels, avatarPixels);
  bitmap.close();
  // A browser that cannot write WebP hands back a PNG instead, which the panel takes too.
  const blob = await toBlob(canvas, "image/webp");
  if (!blob || !(avatarUploadTypes as readonly string[]).includes(blob.type)) throw new AvatarImageError("unreadable");
  if (blob.size > avatarMaxBytes) throw new AvatarImageError("tooBig");
  return toDataUrl(blob);
}
