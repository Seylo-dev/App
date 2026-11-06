// A generic git URL (GitLab, Gitea, a server of your own) with an optional
// stored credential for private repos. "Check access" lists the branches
// the way git ls-remote would, before anything is saved.

import { git, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Input } from "@seylo/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { Field, ToggleRow } from "../field";
import { useInvalidate } from "../invalidate";
import { MutationError, OpErrorNote, retryOp } from "../op-state";
import type { ServiceDetail } from "../use-service";

const publicRepo = "__public__";
const urlPattern = /^(https:\/\/|ssh:\/\/|git@)\S+$/;

export function GitForm({ service }: { service: ServiceDetail }) {
  const src = service.sourceConfig.type === "git" ? service.sourceConfig : null;
  const [url, setUrl] = useState(src?.url ?? "");
  const [branch, setBranch] = useState(src?.branch ?? "main");
  const [credentialId, setCredentialId] = useState<string | null>(src?.credentialId ?? null);
  const [deployOnPush, setDeployOnPush] = useState(src?.deployOnPush ?? false);
  const [check, setCheck] = useState<{ url: string; credentialId: string | null } | null>(null);
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

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ serviceId: service.id, source: { type: "git", url: url.trim(), branch: branch.trim(), credentialId, deployOnPush } });
      }}
    >
      <Field label={t("serviceSource.git.url")} htmlFor="git-url" hint={t("serviceSource.git.urlHint")}>
        <div className="flex gap-2">
          <Input
            id="git-url"
            className="font-mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://git.example.com/team/app.git"
            aria-invalid={url !== "" && !validUrl}
          />
          <Button onClick={() => setCheck({ url: url.trim(), credentialId })} disabled={!validUrl}>
            {t("serviceSource.git.check")}
          </Button>
        </div>
      </Field>
      {check && (
        <div className="text-[12.5px]">
          {branches.isPending ? (
            <span className="text-muted-foreground">{t("serviceSource.git.checking")}</span>
          ) : branches.isError ? (
            <OpErrorNote error={branches.error} compact />
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
            <Link to="/settings/github" className="font-medium">
              {t("serviceSource.git.manageCredentials")}
            </Link>
          }
        >
          <Select value={credentialId ?? publicRepo} onValueChange={(v) => setCredentialId(v === publicRepo ? null : v)}>
            <SelectTrigger aria-label={t("serviceSource.git.credential")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={publicRepo}>{t("serviceSource.git.public")}</SelectItem>
              {(credentials.data?.items ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name} · {c.host}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <ToggleRow
        title={t("serviceSource.deployOnPush")}
        description={t("serviceSource.git.pushHint")}
        control={<Switch checked={deployOnPush} onCheckedChange={setDeployOnPush} aria-label={t("serviceSource.deployOnPush")} />}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={!validUrl || !branch.trim() || save.isPending}>
          {t("service.save")}
        </Button>
        <MutationError error={save.error} />
      </div>
    </form>
  );
}
