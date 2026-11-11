// The Files popup of a volume: browse folders, edit text files in Monaco,
// upload and download through tickets (any size), new folder, rename,
// permissions, compress, extract and delete. Paths are relative to the
// volume root; the node resolves them so nothing can leave the volume.

import { files, type OpOutput } from "@seylo/ops";
import { useOp, useOpClient, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { DataTable } from "@seylo/ui/components/data-table";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input } from "@seylo/ui/components/input";
import { Progress } from "@seylo/ui/components/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import {
  IconArrowLeft,
  IconArrowUp,
  IconChevronRight,
  IconDownload,
  IconFile,
  IconFileZip,
  IconFolder,
  IconFolderPlus,
  IconLink,
  IconRefresh,
  IconTrash,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import { type ChangeEvent, useRef, useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { CodeEditor } from "../editor/code-editor";
import { formatBytes, formatDateTime, formatMode, formatOctal } from "../format";
import { useInvalidate } from "../invalidate";
import { isNotBuilt, MutationError, OpErrorNote, retryOp } from "../op-state";
import type { ServiceDetail } from "../use-service";
import { isArchive, joinPath, languageFor, parentPath, parseOctal, pathCrumbs } from "./file-kinds";

type Entry = OpOutput<typeof files.list>["entries"][number];
type Prompt =
  | { kind: "mkdir" }
  | { kind: "rename"; entry: Entry }
  | { kind: "chmod"; entry: Entry }
  | { kind: "archive"; paths: string[] }
  | null;

export function FilesDialog({ service, volume, onClose }: { service: ServiceDetail; volume: string | null; onClose: () => void }) {
  return (
    <Dialog open={volume !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[6%] flex h-[84dvh] max-w-[1000px] flex-col gap-0 overflow-hidden p-0">
        {volume && <Browser service={service} volume={volume} />}
        <DialogClose asChild>
          <Button
            size="icon"
            className="absolute top-4 right-4 size-8 rounded-control bg-muted shadow-none"
            aria-label={t("service.close")}
          >
            <IconX size={14} stroke={2.2} />
          </Button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

function Browser({ service, volume }: { service: ServiceDetail; volume: string }) {
  const [nodeId, setNodeId] = useState<string | undefined>(service.placements[0]?.nodeId);
  const [path, setPath] = useState("");
  const [open, setOpen] = useState<Entry | null>(null);
  const root = { serviceId: service.id, volume, ...(nodeId ? { nodeId } : {}) };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-divider px-5 pt-[18px] pb-3.5 pr-14">
        <div className="flex min-w-0 flex-col gap-1">
          <DialogTitle>{t("serviceStorage.files.title", { volume })}</DialogTitle>
          <DialogDescription>{t("serviceStorage.files.description")}</DialogDescription>
        </div>
        {service.placements.length > 1 && (
          <Select value={nodeId} onValueChange={setNodeId}>
            <SelectTrigger size="sm" className="ml-auto w-40" aria-label={t("serviceStorage.files.node")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {service.placements.map((p) => (
                <SelectItem key={p.nodeId} value={p.nodeId}>
                  {p.nodeName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {open ? (
        <FileEditor root={root} entry={open} onBack={() => setOpen(null)} />
      ) : (
        <Listing root={root} path={path} onPath={setPath} onOpen={setOpen} />
      )}
    </>
  );
}

type Root = { serviceId: string; volume: string; nodeId?: string };

function Listing({ root, path, onPath, onOpen }: { root: Root; path: string; onPath: (p: string) => void; onOpen: (e: Entry) => void }) {
  const list = useOp(files.list, { ...root, path }, { retry: retryOp });
  const client = useOpClient();
  const invalidate = useInvalidate();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [upload, setUpload] = useState<{ name: string; percent: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const refresh = () => invalidate(files.list);
  const fail = (error: unknown) =>
    toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed")));
  const remove = useOpMutation(files.remove, {
    onSuccess: () => {
      setSelected(new Set());
      refresh();
    },
  });
  const extract = useOpMutation(files.extract, {
    onSuccess: () => {
      refresh();
      toast.success(t("serviceStorage.files.extracted"));
    },
    onError: fail,
  });
  const entries = list.data?.entries ?? [];

  const download = async (entry: Entry) => {
    try {
      const ticket = await client.call(files.downloadTicket, { ...root, path: entry.path });
      const a = document.createElement("a");
      a.href = ticket.url;
      a.download = entry.name;
      a.click();
    } catch (error) {
      fail(error);
    }
  };

  const onUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(e.target.files ?? [])];
    e.target.value = "";
    for (const file of chosen) {
      try {
        const ticket = await client.call(files.uploadTicket, { ...root, path: joinPath(path, file.name), sizeBytes: file.size });
        setUpload({ name: file.name, percent: 0 });
        await putWithProgress(ticket.url, file, (percent) => setUpload({ name: file.name, percent }));
      } catch (error) {
        fail(error);
      }
    }
    setUpload(null);
    refresh();
  };

  const toggle = (p: string) => setSelected((s) => (s.has(p) ? new Set([...s].filter((x) => x !== p)) : new Set([...s, p])));
  const chosen = [...selected];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-5 py-3">
        <nav aria-label={t("serviceStorage.files.path")} className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-[12.5px]">
          <button
            type="button"
            className="cursor-pointer rounded-chip border-0 bg-transparent px-1.5 py-0.5 text-link"
            onClick={() => onPath("")}
          >
            /
          </button>
          {pathCrumbs(path).map((c) => (
            <span key={c.path} className="flex items-center gap-1">
              <IconChevronRight size={12} className="text-ink-ghost" aria-hidden="true" />
              <button
                type="button"
                className="cursor-pointer rounded-chip border-0 bg-transparent px-1.5 py-0.5 text-link"
                onClick={() => onPath(c.path)}
              >
                {c.name}
              </button>
            </span>
          ))}
        </nav>
        <span className="ml-auto flex flex-wrap gap-1.5">
          {chosen.length > 0 && (
            <>
              <Button size="sm" onClick={() => setPrompt({ kind: "archive", paths: chosen })}>
                <IconFileZip size={14} />
                {t("serviceStorage.files.compress", { count: chosen.length })}
              </Button>
              <Button size="sm" className="text-chip-red-fg" onClick={() => setConfirmDelete(chosen)}>
                <IconTrash size={14} />
                {t("serviceStorage.files.deleteSelected", { count: chosen.length })}
              </Button>
            </>
          )}
          <Button size="sm" disabled={!path} onClick={() => onPath(parentPath(path))} aria-label={t("serviceStorage.files.up")}>
            <IconArrowUp size={14} />
          </Button>
          <Button size="sm" onClick={() => setPrompt({ kind: "mkdir" })}>
            <IconFolderPlus size={14} />
            {t("serviceStorage.files.newFolder")}
          </Button>
          <Button size="sm" onClick={() => picker.current?.click()} disabled={upload !== null}>
            <IconUpload size={14} />
            {t("serviceStorage.files.upload")}
          </Button>
          <Button size="sm" onClick={refresh} aria-label={t("service.refresh")}>
            <IconRefresh size={14} />
          </Button>
          <input ref={picker} type="file" multiple className="hidden" onChange={(e) => void onUpload(e)} />
        </span>
      </div>
      {upload && (
        <div className="flex items-center gap-3 px-5 pb-3 text-[12.5px]">
          <span className="truncate">{t("serviceStorage.files.uploading", { name: upload.name })}</span>
          <Progress value={upload.percent} className="max-w-60 flex-1" />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-divider">
        {list.isPending ? (
          <LoadingRegion label={t("common.loading")}>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-2.5 border-b border-divider px-[18px] py-3.5">
                <Skeleton className="size-4 shrink-0 rounded-[4px]" />
                <SkeletonText className="w-40 text-[13px]" />
                <SkeletonText className="ml-auto w-14 text-[13px]" />
                <SkeletonText className="w-24 text-[13px]" />
              </div>
            ))}
          </LoadingRegion>
        ) : list.isError ? (
          <OpErrorNote error={list.error} className="m-5" />
        ) : (
          <DataTable
            bare
            aria-label={t("serviceStorage.files.listLabel")}
            rows={entries}
            getRowId={(e) => e.path}
            onRowClick={(e) => (e.isDir ? onPath(e.path) : e.size <= files.maxInlineFileBytes ? onOpen(e) : void download(e))}
            empty={<p className="m-0 p-5 text-[13px] text-muted-foreground">{t("serviceStorage.files.empty")}</p>}
            columns={[
              {
                id: "select",
                header: "",
                width: "36px",
                cell: (e) => (
                  // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: stops the row click; the checkbox itself is keyboard reachable.
                  <span onClick={(ev) => ev.stopPropagation()} className="flex">
                    <Checkbox
                      checked={selected.has(e.path)}
                      onCheckedChange={() => toggle(e.path)}
                      aria-label={t("serviceStorage.files.select", { name: e.name })}
                    />
                  </span>
                ),
              },
              {
                id: "name",
                header: t("serviceStorage.files.name"),
                sortValue: (e) => `${e.isDir ? 0 : 1}${e.name}`,
                cell: (e) => (
                  <span className="flex min-w-0 items-center gap-2">
                    {e.symlinkTarget ? (
                      <IconLink size={15} className="shrink-0 text-ink-faint" />
                    ) : e.isDir ? (
                      <IconFolder size={15} className="shrink-0 text-chip-blue-fg" />
                    ) : (
                      <IconFile size={15} className="shrink-0 text-ink-faint" />
                    )}
                    <span className="truncate font-mono text-[12.5px]">{e.name}</span>
                    {e.symlinkTarget && <span className="truncate font-mono text-xs text-muted-foreground">→ {e.symlinkTarget}</span>}
                  </span>
                ),
              },
              {
                id: "size",
                header: t("serviceStorage.files.size"),
                align: "right",
                sortValue: (e) => e.size,
                cell: (e) => (e.isDir ? "" : formatBytes(e.size)),
              },
              {
                id: "mode",
                header: t("serviceStorage.files.mode"),
                hideOnMobile: true,
                cell: (e) => (
                  <span className="font-mono text-xs text-muted-foreground" title={formatOctal(e.mode)}>
                    {formatMode(e.mode)}
                  </span>
                ),
              },
              {
                id: "modified",
                header: t("serviceStorage.files.modified"),
                align: "right",
                hideOnMobile: true,
                sortValue: (e) => e.modifiedAt ?? "",
                cell: (e) => (e.modifiedAt ? formatDateTime(e.modifiedAt) : ""),
              },
            ]}
            rowActions={(e) => [
              ...(e.isDir
                ? [{ label: t("serviceStorage.files.openFolder"), onSelect: () => onPath(e.path) }]
                : [
                    ...(e.size <= files.maxInlineFileBytes ? [{ label: t("service.edit"), onSelect: () => onOpen(e) }] : []),
                    { label: t("service.download"), icon: <IconDownload size={14} />, onSelect: () => void download(e) },
                  ]),
              ...(isArchive(e.name)
                ? [
                    {
                      label: t("serviceStorage.files.extract"),
                      onSelect: () => extract.mutate({ ...root, archivePath: e.path, destination: path }),
                    },
                  ]
                : []),
              { label: t("serviceStorage.files.rename"), onSelect: () => setPrompt({ kind: "rename", entry: e }), separated: true },
              { label: t("serviceStorage.files.permissions"), onSelect: () => setPrompt({ kind: "chmod", entry: e }) },
              { label: t("service.remove"), destructive: true, separated: true, onSelect: () => setConfirmDelete([e.path]) },
            ]}
          />
        )}
      </div>
      {prompt && <PromptDialog root={root} dir={path} prompt={prompt} onClose={() => setPrompt(null)} onDone={refresh} />}
      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={t("serviceStorage.files.deleteTitle", { count: confirmDelete?.length ?? 0 })}
        description={t("serviceStorage.files.deleteBody")}
        confirmLabel={t("service.remove")}
        destructive
        onConfirm={() => remove.mutateAsync({ ...root, paths: confirmDelete ?? [] }).then(() => undefined)}
      />
    </div>
  );
}

/** PUT the raw file to the upload ticket URL, reporting progress. */
function putWithProgress(url: string, file: File, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(xhr.statusText)));
    xhr.onerror = () => reject(new Error(xhr.statusText));
    xhr.send(file);
  });
}

function PromptDialog({
  root,
  dir,
  prompt,
  onClose,
  onDone,
}: {
  root: Root;
  dir: string;
  prompt: NonNullable<Prompt>;
  onClose: () => void;
  onDone: () => void;
}) {
  const initial =
    prompt.kind === "rename"
      ? prompt.entry.name
      : prompt.kind === "chmod"
        ? formatOctal(prompt.entry.mode)
        : prompt.kind === "archive"
          ? "archive.tar.gz"
          : "";
  const [value, setValue] = useState(initial);
  const done = () => {
    onDone();
    onClose();
  };
  const mkdir = useOpMutation(files.mkdir, { onSuccess: done });
  const rename = useOpMutation(files.rename, { onSuccess: done });
  const chmod = useOpMutation(files.chmod, { onSuccess: done });
  const archive = useOpMutation(files.archive, { onSuccess: done });
  const busy = mkdir.isPending || rename.isPending || chmod.isPending || archive.isPending;
  const error = mkdir.error ?? rename.error ?? chmod.error ?? archive.error;
  const mode = prompt.kind === "chmod" ? parseOctal(value) : null;

  const submit = () => {
    const name = value.trim();
    if (prompt.kind === "mkdir" && name) mkdir.mutate({ ...root, path: joinPath(dir, name) });
    if (prompt.kind === "rename" && name)
      rename.mutate({ ...root, from: prompt.entry.path, to: joinPath(parentPath(prompt.entry.path), name) });
    if (prompt.kind === "chmod" && mode !== null) chmod.mutate({ ...root, path: prompt.entry.path, mode });
    if (prompt.kind === "archive" && name)
      archive.mutate({ ...root, paths: prompt.paths, destination: joinPath(dir, name), format: name.endsWith(".zip") ? "zip" : "tar.gz" });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogTitle>{t(`serviceStorage.files.prompt.${prompt.kind}`)}</DialogTitle>
          <Input
            autoFocus
            className="font-mono"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={t(`serviceStorage.files.prompt.${prompt.kind}`)}
            aria-invalid={prompt.kind === "chmod" && mode === null}
          />
          {prompt.kind === "chmod" && mode !== null && <span className="font-mono text-xs text-muted-foreground">{formatMode(mode)}</span>}
          <MutationError error={error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t("service.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={busy || (prompt.kind === "chmod" && mode === null)}>
              {t("service.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Whether the editor holds edits the file does not have: against the last
 * save when there was one (the read stays as first loaded), else the read.
 * Text typed during a save stays unsaved: the save wrote what was there
 * when it started.
 */
export function isUnsaved(text: string | null, saved: string | null, loaded: string | undefined): boolean {
  return text !== null && text !== (saved ?? loaded);
}

function FileEditor({ root, entry, onBack }: { root: Root; entry: Entry; onBack: () => void }) {
  const file = useOp(files.readFile, { ...root, path: entry.path }, { retry: retryOp, staleTime: 0, gcTime: 0 });
  const [text, setText] = useState<string | null>(null);
  // What the last save wrote: the file as it is now, so the edits compare with that (the read stays as first loaded).
  const [savedText, setSavedText] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const write = useOpMutation(files.write, {
    onSuccess: (_result, sent) => {
      setSavedText(sent.content);
      invalidate(files.list);
      toast.success(t("service.saved"));
    },
  });
  const content = text ?? (file.data?.encoding === "utf8" ? file.data.content : "");
  const dirty = isUnsaved(text, savedText, file.data?.content);
  const save = () => write.mutate({ ...root, path: entry.path, content, encoding: "utf8" });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-5 py-3">
        <Button size="sm" onClick={onBack}>
          <IconArrowLeft size={14} />
          {t("serviceStorage.files.back")}
        </Button>
        <span className="truncate font-mono text-[12.5px]">{entry.path}</span>
        {dirty && <span className="text-xs text-chip-amber-fg">{t("service.unsavedChanges")}</span>}
        <MutationError error={write.error} />
        <Button size="sm" variant="primary" className="ml-auto" onClick={save} disabled={!dirty || write.isPending}>
          {write.isPending ? t("service.saving") : t("service.save")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 border-t border-divider">
        {file.isPending ? (
          <LoadingRegion label={t("common.loading")} className="flex min-h-0 flex-1 flex-col gap-[9px] p-5">
            {["w-64", "w-80", "w-48", "w-96", "w-56", "w-72"].map((width) => (
              <Skeleton key={width} className={`h-3 max-w-full rounded-chip ${width}`} />
            ))}
          </LoadingRegion>
        ) : file.isError ? (
          <OpErrorNote error={file.error} className="m-5" />
        ) : file.data.encoding === "base64" ? (
          <Callout tone="neutral" className="m-5">
            {t("serviceStorage.files.binary")}
          </Callout>
        ) : (
          <CodeEditor
            value={content}
            language={languageFor(entry.name)}
            onChange={setText}
            onSave={save}
            height="100%"
            aria-label={t("serviceStorage.files.editorLabel", { name: entry.name })}
          />
        )}
      </div>
    </div>
  );
}
