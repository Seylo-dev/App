// Reads an export file in the browser: only its central directory and its
// small entries, never the whole file (the reader slices the File). What
// the panel needs goes to serviceTransfer.importBegin as text; the uploaded
// archive's bytes are sliced from the file when they go up. The panel
// checks everything again; this is for the person, so a damaged or wrong
// file is refused before anything is sent.

import { serviceTransfer } from "@seylo/ops";
import { blobSource, entryStream, openZip, readEntry, type ZipEntry, ZipError } from "@seylo/zip/read";

type Manifest = serviceTransfer.PortableManifestV1;

export interface ExportFile {
  file: Blob;
  size: number;
  manifestText: string;
  manifest: Manifest;
  signature?: string;
  secretsEnc?: string;
  services: { path: string; json: string }[];
  /** The uploaded archive's entry, when the file has one. */
  upload: ZipEntry | null;
}

export class ExportFileError extends Error {}

const limits = serviceTransfer.transferLimits;

export async function readExport(file: Blob): Promise<ExportFile> {
  const source = blobSource(file);
  let opened: Awaited<ReturnType<typeof openZip>>;
  try {
    opened = await openZip(source, { maxEntries: limits.entries, accept: serviceTransfer.isExportEntryName });
  } catch (error) {
    if (error instanceof ZipError) throw new ExportFileError(error.message);
    throw error;
  }
  const text = async (name: string, maxBytes: number) => {
    const entry = opened.entries.find((e) => e.name === name);
    if (!entry) return undefined;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(await readEntry(source, entry, { maxBytes }));
    } catch (error) {
      if (error instanceof ZipError) throw new ExportFileError(error.message);
      throw new ExportFileError(`${name} is not text.`);
    }
  };
  const manifestText = await text(serviceTransfer.entryPatterns.manifest, limits.manifestBytes);
  if (!manifestText) throw new ExportFileError("It has no manifest.json, so it is not an export file.");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestText) as Manifest;
  } catch {
    throw new ExportFileError("Its manifest.json is not JSON.");
  }
  if (manifest?.format !== serviceTransfer.exportFormat || !Array.isArray(manifest.services) || !manifest.services[0]) {
    throw new ExportFileError("It is not a service export file.");
  }
  if (typeof manifest.formatVersion === "number" && manifest.formatVersion > serviceTransfer.exportFormatVersion) {
    throw new ExportFileError(
      `It comes from a newer panel (${String(manifest.panel?.version ?? "").slice(0, 40)}). Update this panel first.`,
    );
  }
  const services: ExportFile["services"] = [];
  for (const entry of opened.entries.filter((e) => serviceTransfer.entryPatterns.service.test(e.name))) {
    services.push({ path: entry.name, json: (await text(entry.name, limits.documentBytes)) as string });
  }
  return {
    file,
    size: file.size,
    manifestText,
    manifest,
    signature: await text(serviceTransfer.entryPatterns.signature, 1000),
    secretsEnc: await text(serviceTransfer.entryPatterns.secrets, limits.documentBytes * 1.5),
    services,
    upload: opened.entries.find((e) => serviceTransfer.entryPatterns.upload.test(e.name)) ?? null,
  };
}

/**
 * The archive's bytes as they go up: a slice of the file when stored (the
 * export's way), inflated first when a zip tool deflated it on a re-zip.
 */
export async function archiveBytes(file: ExportFile, entry: ZipEntry): Promise<Blob> {
  if (entry.method === "store") return file.file.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  return new Response(entryStream(blobSource(file.file), entry)).blob();
}
