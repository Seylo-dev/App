// Settings > Tailscale, second card: "Serve the panel on my tailnet". The
// switch saves on toggle (tailscale.setServe). On: only the owner, and only
// once the server can serve (the reason shows otherwise). Off while the
// tailnet is the only way into a closed panel in "stay closed" mode asks to
// reopen IP access too. Active: the URL with Copy and Open, whether this
// page came over the tailnet, and the exact entry the agent owns.

import { displayName } from "@seylo/brand";
import { OpError, settings, tailscale } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { CopyField } from "@seylo/ui/components/copy-field";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { IconExternalLink } from "@tabler/icons-react";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { isReauthCancelled } from "../../../lib/reauth";
import { invalidateOps } from "../mutation";
import { toastError } from "../op-state";
import { SettingRow } from "../page";
import { isConnecting, serveBlockedReason, type TailscaleStatus } from "./shared";

const stateTitles = {
  conflict: "settingsTailscale.serve.conflict",
  error: "settingsTailscale.serve.error",
  unsupported: "settingsTailscale.serve.unsupported",
} as const;

export function ServeSwitch({ status }: { status: TailscaleStatus }) {
  const [askReopen, setAskReopen] = useState(false);
  const setServe = useOpMutation(tailscale.setServe, {
    onSuccess: async (out, input) => {
      await invalidateOps([tailscale.get, settings.panelAccess, settings.general]);
      if (out.reopenedUrl) toast.success(t("settingsTailscale.serve.reopened", { url: out.reopenedUrl }));
      else if (input.serve) toast.success(t("settingsTailscale.serve.on", { url: out.tailscale.dnsName ?? "?" }));
      else toast.success(t("settingsTailscale.serve.off"));
    },
    onError: (error) => {
      if (error instanceof OpError && error.details?.reason === "stayClosed") {
        setAskReopen(true);
        return;
      }
      toastError(error);
    },
  });
  const { serve } = status;
  const blocked = serveBlockedReason(status);
  // The panel says notSignedIn for every state but Running; Starting is signed in already.
  const blockedText = blocked === "notSignedIn" && isConnecting(status) ? "connecting" : blocked;
  const wanted = setServe.isPending && setServe.variables ? setServe.variables.serve : serve.wanted;
  // On needs the owner and a server that can serve; off is always offered while it is on.
  const canToggle = serve.wanted || (status.canManage && blocked === null);

  return (
    <SectionCard title={t("settingsTailscale.serve.title")} description={t("settingsTailscale.serve.description")}>
      <SettingRow
        title={t("settingsTailscale.serve.toggle")}
        description={
          !serve.wanted && !status.canManage
            ? t("settingsTailscale.serve.ownerOnly")
            : !serve.wanted && blockedText
              ? t(`settingsTailscale.serve.blocked.${blockedText}`)
              : t("settingsTailscale.serve.toggleHint")
        }
        control={
          <Switch
            checked={wanted}
            disabled={!canToggle || setServe.isPending}
            onCheckedChange={(on) => setServe.mutate({ serve: on })}
            aria-label={t("settingsTailscale.serve.toggle")}
          />
        }
      />
      {serve.wanted && <ServeState status={status} />}
      <ConfirmDialog
        open={askReopen}
        onOpenChange={setAskReopen}
        destructive
        title={t("settingsTailscale.serve.onlyPathTitle")}
        description={t("settingsTailscale.serve.onlyPath")}
        confirmLabel={t("settingsTailscale.serve.onlyPathConfirm")}
        onConfirm={async () => {
          try {
            await setServe.mutateAsync({ serve: false, reopenIpAccess: true });
          } catch (error) {
            if (!isReauthCancelled(error)) throw error;
          }
        }}
      />
    </SectionCard>
  );
}

function ServeState({ status }: { status: TailscaleStatus }) {
  const { serve, owned } = status;
  if (serve.state === "conflict" || serve.state === "error" || serve.state === "unsupported") {
    return (
      <Alert tone="danger" title={t(stateTitles[serve.state])}>
        {serve.message || null}
      </Alert>
    );
  }
  if (serve.state === "applying")
    return (
      <Chip tone="blue" className="self-start">
        {t("settingsTailscale.serve.applying")}
      </Chip>
    );
  if (serve.state !== "active" || !serve.url) {
    return <Alert tone="neutral">{t("settingsTailscale.serve.waiting", { min: status.minVersion })}</Alert>;
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="green">{t("settingsTailscale.serve.active")}</Chip>
        {status.viaTailnet && <Chip tone="blue">{t("settingsTailscale.serve.viaTailnet")}</Chip>}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <CopyField value={serve.url} aria-label={t("settingsTailscale.serve.urlLabel")} className="min-w-0 flex-1" />
        <Button asChild>
          <a href={serve.url} target="_blank" rel="noreferrer noopener">
            {t("settingsTailscale.serve.openUrl")}
            <IconExternalLink size={14} stroke={1.9} aria-hidden="true" />
          </a>
        </Button>
      </div>
      {status.https && <p className="m-0 text-[12.5px] text-muted-foreground">{t("settingsTailscale.serve.firstLoad")}</p>}
      {!serve.panelAnswers && <Alert tone="warning">{t("settingsTailscale.serve.notAnswering")}</Alert>}
      {owned && (
        <div className="flex flex-col gap-1">
          <span className="text-[12.5px] font-medium text-ink-strong">{t("settingsTailscale.serve.owned", { name: displayName })}</span>
          <code className="rounded-control bg-raised px-3 py-2 font-mono text-[12.5px] [overflow-wrap:anywhere] whitespace-pre-wrap">
            {`${owned.hostPort}${owned.path} -> ${owned.proxy}`}
          </code>
          <span className="text-xs text-muted-foreground">{t("settingsTailscale.serve.ownedHint", { name: displayName })}</span>
        </div>
      )}
    </div>
  );
}
