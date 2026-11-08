// Internal git hosts: hosts a project's nodes may clone from internal
// addresses (a LAN Gitea, a git server on a node's own address). The panel
// records one when an admin saves a source with it; a member's save or
// "Check access" on one is refused (BAD_REQUEST internalTarget or
// unresolvable, details.host). InternalHostNote shows under such a refusal:
// an admin (git.manage: owners and admins) can allow the host for the
// project right there, after a confirm step; a member sees who to ask.
// DeployHostAction offers the same under a failed deployment the node
// refused for its git host (a name internal only at the nodes, a node behind
// an HTTP proxy, an address only the node knows is its own, a git provider
// connection: the provider form gets no such refusal, since the panel never
// refuses a provider's host), where an admin meets it. InternalGitHosts lists a
// project's hosts for admins, who can allow one or take one off.

import { auth, git, gitProviders, OpError, type OpOutput, projects } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { DataTable } from "@seylo/ui/components/data-table";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input } from "@seylo/ui/components/input";
import { SectionCard } from "@seylo/ui/components/section-card";
import { toast } from "@seylo/ui/components/toast";
import { IconServer2 } from "@tabler/icons-react";
import { type FormEvent, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { formatRelative } from "../service/format";
import { useInvalidate } from "../service/invalidate";
import type { ServiceDetail } from "../service/use-service";

/** Owners and admins hold git.manage. */
export function useCanManageGit(): boolean {
  const me = useOp(auth.whoami, {});
  const role = me.data?.viewer.role;
  return role === "owner" || role === "admin";
}

/** The host an admin can allow for the project, when this error is such a refusal (never a metadata address). */
export function internalHostOf(error: unknown): string | null {
  if (!(error instanceof OpError) || error.code !== "BAD_REQUEST") return null;
  const reason = error.details?.reason;
  const host = error.details?.host;
  return (reason === "internalTarget" || reason === "unresolvable") && host ? host : null;
}

/** The confirm step of allowing a host; calls git.allowInternalHost. */
function AllowHostDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  url,
  host,
  onAllowed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName: string;
  url: string;
  host: string;
  onAllowed?: () => void;
}) {
  const invalidate = useInvalidate();
  const allow = useOpMutation(git.allowInternalHost);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("gitHosts.allow.title", { host, project: projectName })}
      description={t("gitHosts.allow.body", { project: projectName })}
      confirmLabel={t("gitHosts.allow.confirm")}
      onConfirm={async () => {
        const res = await allow.mutateAsync({ projectId, url });
        invalidate(git.listInternalHosts);
        toast.success(t("gitHosts.allow.done", { host: res.host, project: projectName }));
        onAllowed?.();
      }}
    />
  );
}

/**
 * Under a save or "Check access" that was refused for an internal host:
 * "Allow this host for <project>" for admins, who to ask for everyone else.
 * Nothing for other errors.
 */
export function InternalHostNote({
  error,
  projectId,
  url,
  onAllowed,
}: {
  error: unknown;
  projectId: string;
  /** The git URL the refusal was for (git.allowInternalHost records its host). */
  url: string;
  /** After the host was allowed: check or save again. */
  onAllowed?: () => void;
}) {
  const host = internalHostOf(error);
  const admin = useCanManageGit();
  const project = useOp(projects.get, { projectId }, { enabled: host !== null });
  const [open, setOpen] = useState(false);
  if (!host) return null;
  const projectName = project.data?.name ?? t("gitHosts.thisProject");
  if (!admin)
    return (
      <Callout tone="neutral" className="text-[12.5px]">
        {t("gitHosts.note.askAdmin", { host, project: projectName })}
      </Callout>
    );
  return (
    <>
      <Callout
        tone="warning"
        className="text-[12.5px]"
        action={
          <Button size="sm" onClick={() => setOpen(true)}>
            {t("gitHosts.note.allow", { project: projectName })}
          </Button>
        }
      >
        {t("gitHosts.note.admin", { host })}
      </Callout>
      <AllowHostDialog
        open={open}
        onOpenChange={setOpen}
        projectId={projectId}
        projectName={projectName}
        url={url}
        host={host}
        onAllowed={onAllowed}
      />
    </>
  );
}

/** A deployment that failed because of where its git host is: the node's refusal (it names git.allowInternalHost) or the panel's. */
export function refusedForHost(error: string | null | undefined): boolean {
  return !!error && (error.includes("git.allowInternalHost") || error.includes("Only an admin can use an internal git host"));
}

/** The git URL a service clones (generic git, a provider connection's host, GitHub), for git.allowInternalHost. */
export function useSourceUrl(service: ServiceDetail, enabled: boolean): string | null {
  const src = service.sourceConfig;
  const providers = useOp(gitProviders.list, {}, { enabled: enabled && src.type === "provider" });
  if (src.type === "git") return src.url;
  if (src.type === "github") return "https://github.com/";
  if (src.type === "provider") {
    const connection = providers.data?.items.find((c) => c.id === src.providerId);
    return connection ? `https://${connection.host}/` : null;
  }
  return null;
}

/**
 * Under a failed deployment whose git host was refused, by the node (a name
 * that is internal only at the nodes, a node's own address the panel did not
 * know yet, a node behind an HTTP proxy) or by the panel: "Allow this host for
 * <project>" for admins. Nothing for anyone else (the error says to ask one).
 */
export function DeployHostAction({ service, error }: { service: ServiceDetail; error: string | null }) {
  const admin = useCanManageGit();
  const show = admin && refusedForHost(error);
  const url = useSourceUrl(service, show);
  const project = useOp(projects.get, { projectId: service.projectId }, { enabled: show });
  const [open, setOpen] = useState(false);
  if (!show || !url) return null;
  const projectName = project.data?.name ?? t("gitHosts.thisProject");
  return (
    <>
      <span>
        <Button size="sm" onClick={() => setOpen(true)}>
          {t("gitHosts.note.allow", { project: projectName })}
        </Button>
      </span>
      <AllowHostDialog
        open={open}
        onOpenChange={setOpen}
        projectId={service.projectId}
        projectName={projectName}
        url={url}
        host={hostLabel(url)}
      />
    </>
  );
}

type Host = OpOutput<typeof git.listInternalHosts>["items"][number];

/** Project settings: the project's internal git hosts, for admins (nothing for anyone else). */
export function InternalGitHosts({ projectId, projectName }: { projectId: string; projectName: string }) {
  const admin = useCanManageGit();
  const list = useOp(git.listInternalHosts, { projectId }, { enabled: admin });
  const invalidate = useInvalidate();
  const remove = useOpMutation(git.removeInternalHost);
  // What the dialogs are about stays set while they close, so their text does not blank out mid-animation.
  const [removing, setRemoving] = useState<Host | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [allowing, setAllowing] = useState("");
  const [allowOpen, setAllowOpen] = useState(false);
  if (!admin) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    setAllowing(url.trim());
    setAllowOpen(true);
  };

  return (
    <SectionCard title={t("gitHosts.list.title")} description={t("gitHosts.list.description")} flush>
      {list.error ? (
        <Callout tone="danger" className="mx-5 mb-4">
          {errorMessage(list.error, t("common.unknownError"))}
        </Callout>
      ) : (
        <DataTable<Host>
          bare
          aria-label={t("gitHosts.list.title")}
          loading={list.isPending}
          rows={list.data?.items ?? []}
          getRowId={(h) => h.host}
          empty={<EmptyState compact icon={<IconServer2 />} title={t("gitHosts.list.empty")} description={t("gitHosts.list.emptyHint")} />}
          columns={[
            {
              id: "host",
              header: t("gitHosts.list.host"),
              skeletonWidth: "30%",
              cell: (h) => <span className="font-mono text-[12.5px] break-all">{h.host}</span>,
            },
            {
              id: "allowedBy",
              header: t("gitHosts.list.allowedBy"),
              skeletonWidth: "28%",
              skeletonLines: 2,
              cell: (h) => (
                <span className="flex flex-col">
                  <span>{h.approvedBy ? h.approvedBy.name : t("gitHosts.list.recorded")}</span>
                  <span className="text-xs text-muted-foreground">{formatRelative(h.createdAt)}</span>
                </span>
              ),
            },
            {
              id: "usedBy",
              header: t("gitHosts.list.sources"),
              skeletonWidth: "16%",
              cell: (h) => (
                <span className="text-muted-foreground">
                  {h.usedBy > 0 ? t("gitHosts.list.usedBy", { count: h.usedBy }) : t("gitHosts.list.unused")}
                </span>
              ),
            },
            {
              id: "actions",
              header: "",
              align: "right",
              cell: (h) => (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRemoving(h);
                    setRemoveOpen(true);
                  }}
                >
                  {t("gitHosts.list.remove")}
                </Button>
              ),
            },
          ]}
        />
      )}
      <form onSubmit={submit} className="flex flex-col gap-1.5 px-5 pt-3 pb-5">
        <label htmlFor="internal-host-url" className="text-[13px] font-medium">
          {t("gitHosts.add.label")}
        </label>
        <div className="flex gap-2">
          <Input
            id="internal-host-url"
            className="font-mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://git.example.com/team/app.git"
          />
          <Button type="submit" disabled={!url.trim()}>
            {t("gitHosts.add.submit")}
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">{t("gitHosts.add.hint")}</span>
      </form>
      <AllowHostDialog
        open={allowOpen}
        onOpenChange={setAllowOpen}
        projectId={projectId}
        projectName={projectName}
        url={allowing}
        host={hostLabel(allowing)}
        onAllowed={() => {
          setUrl("");
        }}
      />
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        destructive
        title={t("gitHosts.remove.title", { host: removing?.host ?? "" })}
        description={
          removing && removing.usedBy > 0
            ? t("gitHosts.remove.bodyUsed", { count: removing.usedBy, project: projectName })
            : t("gitHosts.remove.body", { project: projectName })
        }
        confirmLabel={t("gitHosts.list.remove")}
        onConfirm={async () => {
          if (!removing) return;
          await remove.mutateAsync({ projectId, host: removing.host });
          invalidate(git.listInternalHosts);
          toast.success(t("gitHosts.remove.done", { host: removing.host }));
        }}
      />
    </SectionCard>
  );
}

/** The host part of a git URL for the dialog title ("git.example.com:3000"); the panel records its own spelling. */
function hostLabel(url: string): string {
  const scp = url.match(/^[^@/\s]+@([^:/\s]+):/);
  if (scp && !url.includes("://")) return scp[1] as string;
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
