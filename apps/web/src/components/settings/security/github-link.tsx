// Your GitHub login: link one (device flow) to sign in with GitHub later,
// optionally with access to private repos, or unlink it.

import { auth, type OpOutput } from "@seylo/ops";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Chip } from "@seylo/ui/components/chip";
import { SectionCard } from "@seylo/ui/components/section-card";
import { toast } from "@seylo/ui/components/toast";
import { IconBrandGithub } from "@tabler/icons-react";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { DeviceCodePanel } from "../device-code";
import { formatDate } from "../format";
import { invalidateOps, useSettingsMutation } from "../mutation";
import { toastError } from "../op-state";

type Security = OpOutput<typeof auth.security>;

export function GithubLinkSection({ github, available }: { github: Security["github"]; available: boolean }) {
  const [repoAccess, setRepoAccess] = useState(false);
  const [flow, setFlow] = useState<OpOutput<typeof auth.githubLinkStart> | null>(null);
  const start = useSettingsMutation(auth.githubLinkStart, { onSuccess: setFlow });
  const poll = useSettingsMutation(auth.githubLinkPoll, { failure: false });
  const unlink = useSettingsMutation(auth.githubUnlink, { invalidates: [auth.security], success: t("settingsSecurity.github.unlinked") });

  return (
    <SectionCard
      title={t("settingsSecurity.github.title")}
      description={t("settingsSecurity.github.description")}
      actions={github && <Chip tone="green">@{github.login}</Chip>}
    >
      {!available && !github && <Alert tone="neutral">{t("settingsSecurity.github.unavailable")}</Alert>}
      {github && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 text-[13px]">
            <IconBrandGithub size={18} stroke={1.8} aria-hidden="true" />
            {t("settingsSecurity.github.linked", { login: github.login, date: formatDate(github.linkedAt) })}
          </span>
          {github.repoAccess && <Chip tone="amber">{t("settingsSecurity.github.repoAccess")}</Chip>}
          <Button size="sm" variant="ghost" className="ml-auto" disabled={unlink.isPending} onClick={() => unlink.mutate({})}>
            {t("settingsSecurity.github.unlink")}
          </Button>
        </div>
      )}
      {available && !github && !flow && (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2">
            <Checkbox id="github-repo" checked={repoAccess} onCheckedChange={(v) => setRepoAccess(v === true)} className="mt-0.5" />
            <label htmlFor="github-repo" className="flex cursor-pointer flex-col gap-0.5 text-[13px]">
              <span className="text-ink-strong">{t("settingsSecurity.github.alsoRepos")}</span>
              <span className="text-xs text-muted-foreground">{t("settingsSecurity.github.alsoReposHint")}</span>
            </label>
          </div>
          <div>
            <Button disabled={start.isPending} onClick={() => start.mutate({ repoAccess })}>
              <IconBrandGithub size={16} stroke={1.8} />
              {t("settingsSecurity.github.link")}
            </Button>
          </div>
        </div>
      )}
      {flow && (
        <DeviceCodePanel
          code={flow}
          poll={async () => (await poll.mutateAsync({ ticket: flow.ticket })).status}
          onCancel={() => setFlow(null)}
          onFinish={(result, error) => {
            setFlow(null);
            if (result === "done") {
              toast.success(t("settingsSecurity.github.linkedToast"));
              void invalidateOps([auth.security]);
            } else if (result === "error") toastError(error, t("settingsSecurity.github.failed"));
            else toast.warning(t(`settingsSecurity.device.${result}`));
          }}
        />
      )}
    </SectionCard>
  );
}
