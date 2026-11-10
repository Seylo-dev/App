// The signed-in person's avatar (Settings > Personal details): a generated
// face (a style and a seed) or an uploaded image. Every account gets a
// random face when it is created, so nobody starts without one. Uploads
// keep the face underneath: removing the upload brings it back. The style
// catalog, seeds and image rules are in ../avatars.ts.

import { Type } from "@sinclair/typebox";
import { AvatarSeed, AvatarStyle, AvatarUrl, avatarMaxBytes } from "../avatars";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty } from "../schemas";

export const AvatarKind = Type.Union([Type.Literal("preset"), Type.Literal("upload")]);

export const Avatar = Type.Object({
  /** What people see: the uploaded image, or the generated face when there is none. */
  kind: AvatarKind,
  /** The generated face, kept while an upload is shown. */
  style: AvatarStyle,
  seed: AvatarSeed,
  /** The image shown now (upload or face). */
  url: AvatarUrl,
  /** The generated face's image, also while an upload is shown. */
  presetUrl: AvatarUrl,
});

const AvatarResult = Type.Object({ avatar: Avatar });

export const mine = defineOp({
  id: "avatars.mine",
  kind: "query",
  summary: "Get your avatar",
  description:
    "Returns the signed-in person's avatar: an uploaded image or a generated face (style and seed), with the URLs to show. An account without one gets a random face now.",
  input: Empty,
  output: AvatarResult,
  permission: permission.signedIn(),
  mcp: false,
  audit: false,
});

export const setPreset = defineOp({
  id: "avatars.setPreset",
  kind: "mutation",
  summary: "Pick a generated avatar",
  description:
    "Makes a generated face (style and seed) the signed-in person's avatar. An uploaded image is removed, so the face shows. Browser sessions only.",
  input: Type.Object({ style: AvatarStyle, seed: AvatarSeed }),
  output: AvatarResult,
  permission: permission.signedIn(),
  mcp: false,
  audit: true,
});

/** About 1 MiB as base64, plus the data URL's head. */
const dataUrlMaxLength = Math.ceil((avatarMaxBytes * 4) / 3) + 64;

export const upload = defineOp({
  id: "avatars.upload",
  kind: "mutation",
  summary: "Upload an avatar image",
  description:
    "Makes an uploaded image the signed-in person's avatar. The file travels as a base64 data URL: PNG, JPEG or WebP, at most 1 MiB (the web app crops it to a square of 256 pixels first). SVG is refused. The generated face stays underneath. Browser sessions only.",
  input: Type.Object({
    dataUrl: Type.String({
      maxLength: dataUrlMaxLength,
      pattern: "^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$",
      errorMessage: "must be a PNG, JPEG or WebP image as a base64 data URL",
    }),
  }),
  output: AvatarResult,
  permission: permission.signedIn(),
  // The image is the person's own picture: kept out of the audit log.
  sensitive: { input: ["dataUrl"] },
  mcp: false,
  audit: true,
  maxBodyBytes: 2 * 1024 * 1024,
});

export const removeUpload = defineOp({
  id: "avatars.removeUpload",
  kind: "mutation",
  summary: "Remove your uploaded avatar",
  description: "Deletes the signed-in person's uploaded image, so their generated face shows again. Browser sessions only.",
  input: Empty,
  output: AvatarResult,
  permission: permission.signedIn(),
  mcp: false,
  audit: true,
});
