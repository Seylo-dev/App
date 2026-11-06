// Files on service volumes (the Files button). Paths are relative to the
// volume root and resolved on the node with openat2(RESOLVE_IN_ROOT), so
// they can never escape it. A service placed on several nodes has one copy
// of each volume per node; nodeId picks one (default: the first placement).
// Large files go through upload and download tickets instead of JSON.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";
import { StreamTicket } from "./logs";
import { Nullable } from "./nodes";

const FilePath = Type.String({ maxLength: 4096, description: 'Relative to the volume root; "" or "." is the root.' });

export const FileEntry = Type.Object({
  name: Type.String(),
  path: Type.String(),
  isDir: Type.Boolean(),
  size: Type.Integer({ minimum: 0 }),
  /** Unix permission bits, for example 420 (0644). */
  mode: Type.Integer({ minimum: 0 }),
  modifiedAt: Nullable(Timestamp),
  /** Set for symlinks; shown, never followed out of the volume. */
  symlinkTarget: Nullable(Type.String()),
  uid: Type.Integer({ minimum: 0 }),
  gid: Type.Integer({ minimum: 0 }),
});

const root = {
  serviceId: Id,
  /** Volume name from the service's storage settings. */
  volume: Type.String({ minLength: 1, maxLength: 64 }),
  nodeId: Type.Optional(Id),
};

const read = (input: { serviceId: string }) => input.serviceId;

/** Files up to this size can be opened in the editor; bigger ones are downloaded. */
export const maxInlineFileBytes = 1 << 20;

export const list = defineOp({
  id: "files.list",
  kind: "query",
  summary: "List a folder",
  description: "Lists the files and folders in one folder of a service volume, folders first.",
  input: Type.Object({ ...root, path: Type.Optional(FilePath) }),
  output: Type.Object({ nodeId: Id, path: Type.String(), entries: Type.Array(FileEntry) }),
  permission: permission.service("files.read", read),
  mcp: true,
  audit: false,
});

export const readFile = defineOp({
  id: "files.read",
  kind: "query",
  summary: "Read a file",
  description:
    "Returns a file's content for the editor: UTF-8 text, or base64 for binary files. Files over 1 MiB fail with BAD_REQUEST; use files.downloadTicket for those.",
  input: Type.Object({ ...root, path: FilePath }),
  output: Type.Object({
    nodeId: Id,
    info: FileEntry,
    encoding: Type.Union([Type.Literal("utf8"), Type.Literal("base64")]),
    content: Type.String(),
  }),
  permission: permission.service("files.read", read),
  // Like files.write: .env and config files hold credentials, so models get the listing, not the content.
  sensitive: { output: ["content"] },
  mcp: true,
  audit: false,
});

export const write = defineOp({
  id: "files.write",
  kind: "mutation",
  summary: "Write a file",
  description: "Creates or replaces a file with the given content (up to 1 MiB). Existing files keep their mode.",
  input: Type.Object({
    ...root,
    path: FilePath,
    content: Type.String({ maxLength: maxInlineFileBytes * 2 }),
    encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")], { default: "utf8" })),
    createParents: Type.Optional(Type.Boolean({ default: false })),
  }),
  output: Type.Object({ nodeId: Id, info: FileEntry }),
  permission: permission.service("files.write", read),
  // File content often holds credentials (.env, config files).
  sensitive: { input: ["content"] },
  mcp: true,
  audit: true,
});

export const mkdir = defineOp({
  id: "files.mkdir",
  kind: "mutation",
  summary: "Create a folder",
  description: "Creates a folder, and its missing parents when parents is set.",
  input: Type.Object({ ...root, path: FilePath, parents: Type.Optional(Type.Boolean({ default: true })) }),
  output: Empty,
  permission: permission.service("files.write", read),
  mcp: true,
  audit: true,
});

export const rename = defineOp({
  id: "files.rename",
  kind: "mutation",
  summary: "Rename or move a file",
  description: "Renames or moves a file or folder inside the same volume. Fails with CONFLICT when the destination exists.",
  input: Type.Object({ ...root, from: FilePath, to: FilePath }),
  output: Empty,
  permission: permission.service("files.write", read),
  mcp: true,
  audit: true,
});

export const chmod = defineOp({
  id: "files.chmod",
  kind: "mutation",
  summary: "Change file permissions",
  description: "Sets the Unix permission bits of a file or folder.",
  input: Type.Object({ ...root, path: FilePath, mode: Type.Integer({ minimum: 0, maximum: 0o7777 }) }),
  output: Empty,
  permission: permission.service("files.write", read),
  mcp: true,
  audit: true,
});

export const remove = defineOp({
  id: "files.delete",
  kind: "destructive",
  summary: "Delete files",
  description: "Deletes files and folders (folders recursively) from a service volume. This cannot be undone.",
  input: Type.Object({ ...root, paths: Type.Array(FilePath, { minItems: 1, maxItems: 1000 }) }),
  output: Empty,
  permission: permission.service("files.write", read),
  mcp: true,
  audit: true,
});

export const archive = defineOp({
  id: "files.archive",
  kind: "mutation",
  summary: "Compress files",
  description: "Packs files and folders into a .tar.gz or .zip archive inside the same volume.",
  input: Type.Object({
    ...root,
    paths: Type.Array(FilePath, { minItems: 1, maxItems: 1000 }),
    destination: FilePath,
    format: Type.Optional(Type.Union([Type.Literal("tar.gz"), Type.Literal("zip")], { default: "tar.gz" })),
  }),
  output: Type.Object({ nodeId: Id, info: FileEntry }),
  permission: permission.service("files.write", read),
  mcp: true,
  audit: true,
});

export const extract = defineOp({
  id: "files.extract",
  kind: "mutation",
  summary: "Extract an archive",
  description: "Unpacks a .tar.gz or .zip archive into a folder of the same volume, creating the folder if needed.",
  input: Type.Object({ ...root, archivePath: FilePath, destination: FilePath }),
  output: Empty,
  permission: permission.service("files.write", read),
  mcp: true,
  audit: true,
});

export const downloadTicket = defineOp({
  id: "files.downloadTicket",
  kind: "query",
  summary: "Get a download link",
  description: "Returns a one-minute link that downloads a file (any size) from a service volume.",
  input: Type.Object({ ...root, path: FilePath }),
  output: StreamTicket,
  permission: permission.service("files.read", read),
  sensitive: { output: ["url", "ticket"] },
  mcp: false,
  audit: false,
});

export const uploadTicket = defineOp({
  id: "files.uploadTicket",
  kind: "mutation",
  summary: "Get an upload link",
  description:
    "Returns a one-minute link that accepts one file upload (PUT with the raw body, any size) into a folder of a service volume. An existing file with that name is replaced.",
  input: Type.Object({
    ...root,
    /** Full path of the file to create, relative to the volume root. */
    path: FilePath,
    sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    createParents: Type.Optional(Type.Boolean({ default: true })),
  }),
  output: StreamTicket,
  permission: permission.service("files.write", read),
  sensitive: { output: ["url", "ticket"] },
  mcp: false,
  audit: true,
});
