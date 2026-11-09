// A generic git URL (GitLab, Gitea, a server of your own) with an optional
// stored credential for private repos. "Check access" lists the branches
// the way git ls-remote would, before anything is saved. People who manage
// git credentials (git.manage) can add one next to the picker, and the new
// one is picked. A picked credential that was deleted meanwhile is named as
// such, and Check access and Save wait for another pick.

import { GitUrl, git, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Input } from "@seylo/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { AddCredentialDialog } from "../../git/add-credential-dialog";
import { gitCredentialsAnchor } from "../../git/credentials-card";
import { InternalHostNote, useCanManageGit } from "../../git/internal-hosts";
import { Field, ToggleRow } from "../field";
import { useInvalidate } from "../invalidate";
import { MutationError, OpErrorNote, retryOp } from "../op-state";
import { CardSaveBar } from "../save-bar";
import type { ServiceDetail } from "../use-service";

const publicRepo = "__public__";
// The panel's own rule: no user name, token or password in the URL (they go in a git credential).
const urlPattern = new RegExp(GitUrl.pattern as string);
const anyGitUrl = /^(https:\/\/|ssh:\/\/|git@)\S+$/;

export function GitForm({ service }: { service: ServiceDetail }) {
  const src = service.sourceConfig.type === "git" ? service.sourceConfig : null;
  const [url, setUrl] = useState(src?.url ?? "");
  const [branch, setBranch] = useState(src?.branch ?? "main");
  const [credentialId, setCredentialId] = useState<string | null>(src?.credentialId ?? null);
  const [deployOnPush, setDeployOnPush] = useState(src?.deployOnPush ?? false);
  const [check, setCheck] = useState<{ url: string; credentialId: string | null } | null>(null);
  const [adding, setAdding] = useState(false);
  const canManageGit = useCanManageGit();
  const credentials = useOp(git.listCredentials, {}, { retry: retryOp });
  const branches = useOp(
    git.branches,
    { projectId: service.projectId, url: check?.url ?? "", credentialId: check?.credentialId ?? undefined },
    { enabled: !!check, retry: false },
  );
  const invalidate = useInvalidate();
  const save = useOpMutation(services.setSource, {
    onSuccess: () => {
      invalidate(services.get);
      toast.success(t("service.saved"));
    },
  });
  const validUrl = urlPattern.test(url.trim());
  const hasCredentials = !validUrl && anyGitUrl.test(url.trim());
  // The picked credential was deleted (on Settings or in another tab): the panel would refuse its id,
  // so Check access and Save wait until another one, or none, is picked.
  const credentialGone =
    credentialId !== null && credentials.data !== undefined && !credentials.data.items.some((c) => c.id === credentialId);

  const submit = () => {
    if (credentialGone) return;
    save.mutate({ serviceId: service.id, source: { type: "git", url: url.trim(), branch: branch.trim(), credentialId, deployOnPush } });
  };
  // A shown "Check access" answer was for the credential picked then; it says nothing about another one.
  const pickCredential = (id: string | null) => {
    setCredentialId(id);
    setCheck(null);
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field
        label={t("serviceSource.git.url")}
        htmlFor="git-url"
        hint={
          hasCredentials ? (
            <span className="text-destructive">{t("serviceSource.git.urlHasCredentials")}</span>
          ) : (
            t("serviceSource.git.urlHint")
          )
        }
      >
        <div className="flex gap-2">
          <Input
            id="git-url"
            className="font-mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://git.example.com/team/app.git"
            aria-invalid={url !== "" && !validUrl}
          />
          <Button onClick={() => setCheck({ url: url.trim(), credentialId })} disabled={!validUrl || credentialGone}>
            {t("serviceSource.git.check")}
          </Button>
        </div>
      </Field>
      {check && (
        <div className="text-[12.5px]">
          {branches.isPending ? (
            <span className="text-muted-foreground">{t("serviceSource.git.checking")}</span>
          ) : branches.isError ? (
            <div className="flex flex-col gap-2">
              <OpErrorNote error={branches.error} compact />
              <InternalHostNote error={branches.error} projectId={service.projectId} />
            </div>
          ) : (
            <span className="text-chip-green-fg">
              {t("serviceSource.git.reachable", { count: branches.data.branches.length, branch: branches.data.defaultBranch ?? "-" })}
            </span>
          )}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t("serviceSource.git.branch")} htmlFor="git-branch">
          {branches.data?.branches.length ? (
            <Select value={branch} onValueChange={setBranch}>
              <SelectTrigger id="git-branch" className="font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {branches.data.branches.map((b) => (
                  <SelectItem key={b} value={b} className="font-mono">
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input id="git-branch" className="font-mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
          )}
        </Field>
        <Field
          label={t("serviceSource.git.credential")}
          hint={
            canManageGit && (
              <Link to="/settings/git-providers" hash={gitCredentialsAnchor} className="font-medium">
                {t("serviceSource.git.manageCredentials")}
              </Link>
            )
          }
        >
          <div className="flex min-w-0 gap-2">
            <Select value={credentialId ?? publicRepo} onValueChange={(v) => pickCredential(v === publicRepo ? null : v)}>
              <SelectTrigger
                aria-label={t("serviceSource.git.credential")}
                aria-invalid={credentialGone || undefined}
                aria-describedby={credentialGone ? "git-credential-gone" : undefined}
                className="min-w-0 flex-1"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={publicRepo}>{t("serviceSource.git.public")}</SelectItem>
                {/* Keeps the trigger from going blank; it cannot be picked again. */}
                {credentialGone && credentialId && (
                  <SelectItem value={credentialId} disabled>
                    {t("gitCredentials.picker.deleted")}
                  </SelectItem>
                )}
                {(credentials.data?.items ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} · {c.host}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {canManageGit && (
              <Button onClick={() => setAdding(true)}>
                <IconPlus size={15} stroke={1.8} />
                {t("gitCredentials.add.open")}
              </Button>
            )}
          </div>
          {credentialGone && (
            <p id="git-credential-gone" className="m-0 text-[12.5px] text-chip-red-fg">
              {t("gitCredentials.picker.deletedNote")}
            </p>
          )}
        </Field>
      </div>
      <ToggleRow
        title={t("serviceSource.deployOnPush")}
        description={t("serviceSource.git.pushHint")}
        control={<Switch checked={deployOnPush} onCheckedChange={setDeployOnPush} aria-label={t("serviceSource.deployOnPush")} />}
      />
      <InternalHostNote error={save.error} projectId={service.projectId} />
      <CardSaveBar>
        <Button type="submit" size="sm" variant="primary" disabled={!validUrl || !branch.trim() || save.isPending || credentialGone}>
          {t("service.save")}
        </Button>
        <MutationError error={save.error} />
      </CardSaveBar>
      {/* The dialog's own form stops its submit, which React would otherwise bubble out of the portal into this form. */}
      {canManageGit && (
        <AddCredentialDialog open={adding} onOpenChange={setAdding} url={url.trim()} onCreated={(c) => pickCredential(c.id)} />
      )}
    </form>
  );
}
