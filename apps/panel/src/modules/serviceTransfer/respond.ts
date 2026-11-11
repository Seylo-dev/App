// Small pieces the download and upload links share: JSON error answers,
// who did it in words, and reading a file on the panel's disk.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { crc32 } from "node:zlib";
import { OpError } from "@seylo/ops";
import type { Principal } from "../../auth/principal";
import { errorBody } from "../files/http";

export function failure(error: unknown, fallback: string): Response {
  const op = error instanceof OpError ? error : new OpError("INTERNAL", fallback);
  return new Response(JSON.stringify(op.toBody()), { status: op.status, headers: { "content-type": "application/json" } });
}

export function plain(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify(errorBody(code, message)), { status, headers: { "content-type": "application/json" } });
}

export function actorOf(principal: Principal): string | null {
  if (principal.type === "anonymous") return null;
  return principal.type === "apiKey" ? `${principal.user.email} via key ${principal.keyName}` : principal.user.email;
}

export function userIdOf(principal: Principal): string | null {
  return principal.type === "anonymous" ? null : principal.user.id;
}

/** Size, CRC-32 and sha256 of a file, read once. */
export async function fileFacts(path: string): Promise<{ size: number; crc32: number; sha256: string }> {
  const hash = createHash("sha256");
  let crc = 0;
  let size = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    const bytes = chunk as Buffer;
    crc = crc32(bytes, crc) >>> 0;
    hash.update(bytes);
    size += bytes.length;
  }
  return { size, crc32: crc, sha256: hash.digest("hex") };
}

export async function* fileChunks(path: string): AsyncGenerator<Uint8Array> {
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) yield chunk as Buffer;
}
