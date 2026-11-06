// Files on service volumes (the Files button), relayed to the agent of the
// node holding the volume copy. Small files go through ops as JSON; any
// size goes through one-minute download and upload links (http.ts).
// Contracts: packages/ops/src/ops/files.ts.

import { timestampDate } from "@bufbuild/protobuf/wkt";
import { files, OpError } from "@seylo/ops";
import { ArchiveFormat, type FileInfo } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import { pickServiceNode, ticketsFor } from "../../agent-hub/relay";
import { volumes } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { defineModule } from "../module";
import { type DownloadTicket, downloadPath, filesHttp, type UploadTicket, uploadPath } from "./http";

const maxInline = files.maxInlineFileBytes;
/** Archive and extract walk whole trees. */
const slowTimeoutMs = 10 * 60_000;

export function toFileEntry(info: FileInfo | undefined) {
  return {
    name: info?.name ?? "",
    path: info?.path ?? "",
    isDir: info?.isDir ?? false,
    size: Number(info?.size ?? 0n),
    mode: info?.mode ?? 0,
    modifiedAt: info?.modifiedAt ? timestampDate(info.modifiedAt).toISOString() : null,
    symlinkTarget: info?.symlinkTarget || null,
    uid: info?.uid ?? 0,
    gid: info?.gid ?? 0,
  };
}

/** Normalises a volume path: "" and "." are the root; no leading slash. */
export function cleanPath(path: string | undefined): string {
  const trimmed = (path ?? "").replace(/^\/+/, "");
  return trimmed === "." ? "" : trimmed;
}

/** The node to use and the agent's root for a request; checks the volume exists. */
export function resolveRoot(ctx: Pick<OpContext, "db">, input: { serviceId: string; volume: string; nodeId?: string }) {
  const node = pickServiceNode(ctx.db, input.serviceId, input.nodeId);
  const volume = ctx.db
    .select({ name: volumes.name, ownerServiceId: volumes.ownerServiceId })
    .from(volumes)
    .where(and(eq(volumes.serviceId, input.serviceId), eq(volumes.name, input.volume), eq(volumes.kind, "volume")))
    .get();
  if (!volume) throw new OpError("NOT_FOUND", "This service has no volume with that name.", { field: "volume" });
  // Shared compose volumes live in the owner member's folder.
  return { node, root: { serviceId: volume.ownerServiceId ?? input.serviceId, volume: volume.name } };
}

/** UTF-8 without NUL bytes shows as text; anything else as base64. */
export function encodeContent(bytes: Uint8Array): { encoding: "utf8" | "base64"; content: string } {
  if (!bytes.includes(0)) {
    try {
      return { encoding: "utf8", content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
      // not UTF-8
    }
  }
  return { encoding: "base64", content: Buffer.from(bytes).toString("base64") };
}

const list = implement(files.list, async (input, ctx) => {
  const { node, root } = resolveRoot(ctx, input);
  const path = cleanPath(input.path);
  const res = await ctx.agents.call(node.id, "fsList", { root, path });
  const entries = res.entries.map(toFileEntry).sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  return { nodeId: node.id, path, entries };
});

const readFile = implement(files.readFile, async (input, ctx) => {
  const { node, root } = resolveRoot(ctx, input);
  const path = cleanPath(input.path);
  const stat = await ctx.agents.call(node.id, "fsStat", { root, path });
  if (stat.info?.isDir) throw new OpError("BAD_REQUEST", "This is a folder.", { field: "path" });
  if (Number(stat.info?.size ?? 0n) > maxInline) {
    throw new OpError("BAD_REQUEST", "This file is larger than 1 MiB. Download it instead.", { field: "path" });
  }
  const read = ctx.agents.openRaw(node.id, "fsRead", { root, path, length: BigInt(maxInline + 1) });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of read.body) {
    size += chunk.length;
    if (size > maxInline) {
      read.cancel("file grew past the inline limit");
      throw new OpError("BAD_REQUEST", "This file is larger than 1 MiB. Download it instead.", { field: "path" });
    }
    chunks.push(chunk);
  }
  const res = await read.response;
  return { nodeId: node.id, info: toFileEntry(res.info ?? stat.info), ...encodeContent(Buffer.concat(chunks)) };
});

const write = implement(files.write, async (input, ctx) => {
  const { node, root } = resolveRoot(ctx, input);
  const bytes = input.encoding === "base64" ? Buffer.from(input.content, "base64") : Buffer.from(input.content, "utf8");
  if (bytes.length > maxInline)
    throw new OpError("BAD_REQUEST", "The content is larger than 1 MiB. Upload the file instead.", { field: "content" });
  const upload = ctx.agents.openRaw(node.id, "fsWrite", {
    root,
    path: cleanPath(input.path),
    sizeBytes: BigInt(bytes.length),
    createParents: input.createParents ?? false,
  });
  await upload.writer.write(bytes);
  upload.writer.end();
  const res = await upload.response;
  return { nodeId: node.id, info: toFileEntry(res.info) };
});

const mkdir = implement(files.mkdir, async (input, ctx) => {
  const { node, root } = resolveRoot(ctx, input);
  await ctx.agents.call(node.id, "fsMkdir", { root, path: cleanPath(input.path), parents: input.parents ?? true });
  return {};
});

const rename = implement(files.rename, async (input, ctx) => {
  const { node, root } = resolveRoot(ctx, input);
  await ctx.agents.call(node.id, "fsRename", { root, from: cleanPath(input.from), to: cleanPath(input.to) });
  return {};
});

const chmod = implement(files.chmod, async (input, ctx) => {
  const { node, root } = resolveRoot(ctx, input);
  await ctx.agents.call(node.id, "fsChmod", { root, path: cleanPath(input.path), mode: input.mode });
  return {};
});

const remove = implement(files.remove, async (input, ctx) => {
  const { node, root } = resolveRoot(ctx, input);
  const paths = input.paths.map(cleanPath);
  if (paths.includes("")) throw new OpError("BAD_REQUEST", "The volume root itself cannot be deleted.", { field: "paths" });
  await ctx.agents.call(node.id, "fsDelete", { root, paths });
  return {};
});

const archive = implement(files.archive, async (input, ctx) => {
  const { node, root } = resolveRoot(ctx, input);
  const res = await ctx.agents.call(
    node.id,
    "fsArchive",
    {
      root,
      paths: input.paths.map(cleanPath),
      destination: cleanPath(input.destination),
      format: input.format === "zip" ? ArchiveFormat.ZIP : ArchiveFormat.TAR_GZ,
    },
    { timeoutMs: slowTimeoutMs },
  );
  return { nodeId: node.id, info: toFileEntry(res.archive) };
});

const extract = implement(files.extract, async (input, ctx) => {
  const { node, root } = resolveRoot(ctx, input);
  await ctx.agents.call(
    node.id,
    "fsExtract",
    { root, archivePath: cleanPath(input.archivePath), destination: cleanPath(input.destination) },
    { timeoutMs: slowTimeoutMs },
  );
  return {};
});

const downloadTicket = implement(files.downloadTicket, (input, ctx) => {
  const { node, root } = resolveRoot(ctx, input);
  if (!ctx.agents.supports(node.id, "fsRead"))
    throw new OpError("UNAVAILABLE", "The node is offline. Try again when it is back.", { reason: "offline" });
  const data: DownloadTicket = { nodeId: node.id, root, path: cleanPath(input.path) };
  const issued = ticketsFor(ctx).issue({ principal: ctx.principal, action: "files.read", serviceId: input.serviceId }, data);
  return {
    url: `${downloadPath}?t=${encodeURIComponent(issued.ticket)}`,
    ticket: issued.ticket,
    expiresAt: issued.expiresAt.toISOString(),
  };
});

const uploadTicket = implement(files.uploadTicket, (input, ctx) => {
  const { node, root } = resolveRoot(ctx, input);
  if (!ctx.agents.supports(node.id, "fsWrite"))
    throw new OpError("UNAVAILABLE", "The node is offline. Try again when it is back.", { reason: "offline" });
  const data: UploadTicket = {
    nodeId: node.id,
    root,
    path: cleanPath(input.path),
    sizeBytes: input.sizeBytes ?? null,
    createParents: input.createParents ?? true,
  };
  const issued = ticketsFor(ctx).issue({ principal: ctx.principal, action: "files.write", serviceId: input.serviceId }, data);
  return { url: `${uploadPath}?t=${encodeURIComponent(issued.ticket)}`, ticket: issued.ticket, expiresAt: issued.expiresAt.toISOString() };
});

export default defineModule({
  name: "files",
  ops: [list, readFile, write, mkdir, rename, chmod, remove, archive, extract, downloadTicket, uploadTicket],
  http: filesHttp,
});
