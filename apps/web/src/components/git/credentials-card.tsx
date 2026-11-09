// Settings > Git providers > Git credentials: the tokens and SSH keys that
// git URL sources clone with (git.listCredentials), for people who manage
// them (git.manage: owners and admins). Add one, edit one (rename it, replace
// a token and its user name, or set an SSH key's host keys; its public key
// shows there too, to add it to another repository) or delete one; the panel
// refuses to delete a credential a service still clones with, so the dialog
// says how many do instead of offering a delete that fails. The GitHub
// account connected on Settings > GitHub is managed there.

import { git } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { CopyField } from "@seylo/ui/components/copy-field";
import { DataTable } from "@seylo/ui/components/data-table";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input } from "@seylo/ui/components/input";
import { SectionCard } from "@seylo/ui/components/section-card";
import { IconKey, IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { t } from "../../i18n/t";
import { Field } from "../service/field";
import { MutationError } from "../service/op-state";
import { formatDate } from "../settings/format";
import { useSettingsMutation } from "../settings/mutation";
import { OpErrorCallout } from "../settings/op-state";
import { AddCredentialDialog, type GitCredential, HostKeys, useHostKeys } from "./add-credential-dialog";
import { knownHostsCover, needsKnownHosts } from "./credential-host";
import { useCanManageGit } from "./internal-hosts";

/** The card's id, for links that scroll to it (/settings/git-providers#git-credentials). */
export const gitCredentialsAnchor = "git-credentials";

const refresh = [git.listCredentials];

/** The card, or nothing for people who cannot manage git credentials. */
export function GitCredentialsCard() {
  const canManage = useCanManageGit();
  if (!canManage) return null;
  return <CredentialsList />;
}

function CredentialsList() {
  const list = useOp(git.listCredentials, {});
  const [adding, setAdding] = useState(false);
  // What a dialog is about stays set while it closes, so its text does not blank out mid-animation.
  const [editing, setEditing] = useState<GitCredential | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  // A new form for every opening: a typed replacement token never survives a close.
  const [editKey, setEditKey] = useState(0);
  const [removing, setRemoving] = useState<GitCredential | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const remove = useSettingsMutation(git.deleteCredential, {
    invalidates: refresh,
    success: t("gitCredentials.remove.done"),
    failure: false,
  });

  return (
    <SectionCard
      id={gitCredentialsAnchor}
      className="scroll-mt-6"
      title={t("gitCredentials.list.title")}
      description={t("gitCredentials.list.description")}
      flush
      actions={
        <Button size="sm" onClick={() => setAdding(true)}>
          <IconPlus size={15} stroke={1.8} />
          {t("gitCredentials.list.add")}
        </Button>
      }
    >
      {list.error ? (
        <OpErrorCallout error={list.error} onRetry={() => void list.refetch()} className="mx-5 mb-5" />
      ) : (
        <DataTable<GitCredential>
          bare
          aria-label={t("gitCredentials.list.title")}
          loading={list.isPending}
          rows={list.data?.items ?? []}
          getRowId={(c) => c.id}
          empty={
            <EmptyState
              compact
              icon={<IconKey />}
              title={t("gitCredentials.list.empty")}
              description={t("gitCredentials.list.emptyHint")}
            />
          }
          columns={[
            {
              id: "name",
              header: t("gitCredentials.list.name"),
              skeletonWidth: "30%",
              cell: (c) => (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.name}</span>
                  <Chip tone="gray">{t(`gitCredentials.kinds.${c.kind}`)}</Chip>
                  {isGithubAccount(c) && <Chip tone="sky">{t("gitCredentials.list.githubAccount")}</Chip>}
                  {missingHostKeys(c) && <Chip tone="amber">{t("gitCredentials.list.hostKeysMissing")}</Chip>}
                </span>
              ),
            },
            {
              id: "host",
              header: t("gitCredentials.list.host"),
              skeletonWidth: "16%",
              cell: (c) => <span className="font-mono text-[12.5px] break-all">{c.host}</span>,
            },
            {
              id: "username",
              header: t("gitCredentials.list.username"),
              skeletonWidth: "12%",
              hideOnMobile: true,
              cell: (c) => <span className="font-mono text-[12.5px]">{c.kind === "token" ? (c.username ?? "-") : "-"}</span>,
            },
            {
              id: "added",
              header: t("gitCredentials.list.added"),
              skeletonWidth: "14%",
              skeletonLines: 2,
              cell: (c) => (
                <span className="flex flex-col">
                  <span>{formatDate(c.createdAt)}</span>
                  <span className="text-xs text-muted-foreground">
                    {c.usedBy > 0 ? t("gitCredentials.list.usedBy", { count: c.usedBy }) : t("gitCredentials.list.unused")}
                  </span>
                </span>
              ),
            },
            {
              id: "actions",
              header: "",
              align: "right",
              cell: (c) =>
                isGithubAccount(c) ? (
                  <Button asChild size="sm" variant="ghost">
                    <Link to="/settings/github">{t("gitCredentials.list.onGithubPage")}</Link>
                  </Button>
                ) : (
                  <span className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(c);
                        setEditKey((k) => k + 1);
                        setEditOpen(true);
                      }}
                    >
                      {t("gitCredentials.list.edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setRemoving(c);
                        setRemoveOpen(true);
                      }}
                    >
                      {t("gitCredentials.list.delete")}
                    </Button>
                  </span>
                ),
            },
          ]}
        />
      )}
      <AddCredentialDialog open={adding} onOpenChange={setAdding} />
      <EditDialog credential={editing} formKey={editKey} open={editOpen} onOpenChange={setEditOpen} />
      {removing && removing.usedBy > 0 ? (
        <InUseDialog credential={removing} open={removeOpen} onOpenChange={setRemoveOpen} />
      ) : (
        <ConfirmDialog
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          destructive
          title={t("gitCredentials.remove.title", { name: removing?.name ?? "" })}
          description={t("gitCredentials.remove.body")}
          confirmLabel={t("gitCredentials.list.delete")}
          onConfirm={async () => {
            if (removing) await remove.mutateAsync({ credentialId: removing.id });
          }}
        />
      )}
    </SectionCard>
  );
}

/** An SSH key for a host whose keys the panel does not know, with no saved line for that host: it cannot connect. */
export function missingHostKeys(credential: GitCredential): boolean {
  return credential.kind === "ssh_key" && needsKnownHosts(credential.host) && !knownHostsCover(credential.knownHosts, credential.host);
}

/**
 * Changes a credential (git.updateCredential): its name, a token and its user
 * name, or an SSH key's host keys. An SSH key's public key shows here to copy again.
 */
function EditDialog({
  credential,
  formKey,
  open,
  onOpenChange,
}: {
  credential: GitCredential | null;
  formKey: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[84dvh] max-w-[500px] overflow-y-auto">
        {credential && <EditForm key={`${credential.id}:${formKey}`} credential={credential} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function EditForm({ credential, onClose }: { credential: GitCredential; onClose: () => void }) {
  const isToken = credential.kind === "token";
  const keysNeeded = credential.kind === "ssh_key" && needsKnownHosts(credential.host);
  const [name, setName] = useState(credential.name);
  const [username, setUsername] = useState(credential.username ?? "");
  const [token, setToken] = useState("");
  const hostKeys = useHostKeys(credential.knownHosts);
  const update = useSettingsMutation(git.updateCredential, {
    invalidates: refresh,
    success: t("gitCredentials.edit.saved"),
    failure: false,
    onSuccess: onClose,
  });

  const trimmed = name.trim();
  const lines = hostKeys.knownHosts.trim();
  // Only what changed goes to the panel: an empty token field keeps the stored token.
  const changes = {
    ...(trimmed !== credential.name ? { name: trimmed } : {}),
    ...(isToken && username.trim() !== (credential.username ?? "") ? { username: username.trim() || null } : {}),
    ...(isToken && token.trim() !== "" ? { token: token.trim() } : {}),
    ...(keysNeeded && lines !== credential.knownHosts.trim() ? { knownHosts: lines } : {}),
  };
  const ready = trimmed !== "" && (changes.knownHosts === undefined || knownHostsCover(lines, credential.host));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || update.isPending) return;
    if (Object.keys(changes).length === 0) onClose();
    else update.mutate({ credentialId: credential.id, ...changes });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <DialogTitle>{t("gitCredentials.edit.title", { name: credential.name })}</DialogTitle>
        <DialogDescription className="font-mono text-[12.5px]">
          {t(`gitCredentials.kinds.${credential.kind}`)} · {credential.host}
        </DialogDescription>
      </div>
      <Field label={t("gitCredentials.edit.name")} htmlFor="credential-edit-name">
        <Input id="credential-edit-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      {isToken && (
        <>
          <Field label={t("gitCredentials.add.username")} htmlFor="credential-edit-username" hint={t("gitCredentials.add.usernameHint")}>
            <Input
              id="credential-edit-username"
              className="font-mono"
              value={username}
              maxLength={100}
              autoComplete="off"
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label={t("gitCredentials.edit.token")} htmlFor="credential-edit-token" hint={t("gitCredentials.edit.tokenHint")}>
            <Input
              id="credential-edit-token"
              type="password"
              className="font-mono"
              value={token}
              maxLength={1000}
              autoComplete="new-password"
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
        </>
      )}
      {credential.kind === "ssh_key" && credential.publicKey && (
        <Field label={t("gitCredentials.add.publicKey")} hint={credential.fingerprint ?? undefined}>
          <CopyField value={credential.publicKey} aria-label={t("gitCredentials.add.publicKey")} />
        </Field>
      )}
      {keysNeeded && <HostKeys host={credential.host} keys={hostKeys} />}
      <MutationError error={update.error} />
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!ready || update.isPending}>
          {t("gitCredentials.edit.save")}
        </Button>
      </div>
    </form>
  );
}

/** A credential services still clone with: the panel refuses to delete it, so say how many use it. */
function InUseDialog({
  credential,
  open,
  onOpenChange,
}: {
  credential: GitCredential;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <DialogTitle>{t("gitCredentials.remove.usedTitle", { name: credential.name })}</DialogTitle>
            <DialogDescription className="leading-relaxed">
              {t("gitCredentials.remove.usedBody", { count: credential.usedBy })}
            </DialogDescription>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => onOpenChange(false)} autoFocus>
              {t("gitCredentials.remove.close")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The connected GitHub account, by device sign-in or a pasted token: managed on Settings > GitHub. */
function isGithubAccount(c: { origin: string }): boolean {
  return c.origin === "device" || c.origin === "github_token";
}
