// Settings > Tailscale, third card: "Lock to Tailscale". A checklist of
// what has to be true and what will change, the ways back in with an "I
// saved these" tick, and one button that turns off Serve on IP address
// (plus the agents' port when no other node needs it) through
// settings.updatePanelAccess, then removes the panel domain if ticked. The
// panel only allows it from a page opened on the tailnet URL; the button
// says so before the panel has to.

import { settings } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Chip } from "@seylo/ui/components/chip";
import { CodeBlock } from "@seylo/ui/components/code-block";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { SectionCard } from "@seylo/ui/components/section-card";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import { IconCircleCheck, IconCircleDashed } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { t } from "../../../i18n/t";
import { isReauthCancelled } from "../../../lib/reauth";
import { invalidateOps } from "../mutation";
import { QueryView } from "../op-state";
import { commands, type TailscaleStatus } from "./shared";

type PanelAccess = settings.PanelAccess;

function Row({ ok, children }: { ok: boolean; children: ReactNode }) {
  const Icon = ok ? IconCircleCheck : IconCircleDashed;
  return (
    <li className="flex items-start gap-2 text-[13px]">
      <Icon size={17} stroke={1.9} aria-hidden="true" className={cn("mt-px shrink-0", ok ? "text-status-ok" : "text-ink-faint")} />
      <span className={cn("min-w-0 [overflow-wrap:anywhere]", ok ? "text-ink-strong" : "text-muted-foreground")}>{children}</span>
    </li>
  );
}

export function LockChecklist({ status }: { status: TailscaleStatus }) {
  const access = useOp(settings.panelAccess, {});
  const general = useOp(settings.general, {});
  return (
    <SectionCard title={t("settingsTailscale.lock.title")} description={t("settingsTailscale.lock.description")}>
      <QueryView query={access} skeletonRows={4} className="flex flex-col gap-3">
        {(data) => <Checklist status={status} access={data} domain={general.data?.domain ?? null} />}
      </QueryView>
    </SectionCard>
  );
}

function Checklist({ status, access, domain }: { status: TailscaleStatus; access: PanelAccess; domain: string | null }) {
  const [saved, setSaved] = useState(false);
  const [removeDomain, setRemoveDomain] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const update = useOpMutation(settings.updatePanelAccess);
  const updateGeneral = useOpMutation(settings.updateGeneral);

  if (!access.serveOnIp) return <Locked access={access} domain={domain} />;

  const running = status.backendState === "Running";
  const serving = status.serve.state === "active" && status.serve.panelAnswers;
  const url = status.serve.url;
  const onAgentPort = access.agentPortBlocked.find((block) => block.code === "nodesOnAgentPort");
  const agentPortCloses = access.agentPort !== null && access.agentPortOpen && access.agentPortBlocked.length === 0;
  const ready = running && serving && status.viaTailnet && access.blocked.length === 0;

  async function lock() {
    try {
      await update.mutateAsync({ serveOnIp: false, ...(agentPortCloses ? { agentPortOpen: false } : {}) });
      if (removeDomain && domain) {
        await updateGeneral.mutateAsync({ domain: null });
        toast.success(t("settingsTailscale.lock.domainRemoved"));
      }
      await invalidateOps([settings.panelAccess, settings.general]);
      toast.success(t("settingsTailscale.lock.done"));
    } catch (error) {
      // Closing the "Confirm it's you" dialog is not an error to show.
      if (!isReauthCancelled(error)) throw error;
    }
  }

  return (
    <>
      <ul aria-label={t("settingsTailscale.lock.title")} className="m-0 flex list-none flex-col gap-2 p-0">
        <Row ok={running}>{t("settingsTailscale.lock.rows.running")}</Row>
        <Row ok={serving}>{url ? t("settingsTailscale.lock.rows.serving", { url }) : t("settingsTailscale.lock.rows.servingOff")}</Row>
        <Row ok={status.viaTailnet}>
          {status.viaTailnet ? (
            t("settingsTailscale.lock.rows.onTailnet")
          ) : url ? (
            <>
              {t("settingsTailscale.lock.rows.notOnTailnet", { url })}{" "}
              <a href={url} target="_blank" rel="noreferrer noopener" className="text-link hover:text-link-hover">
                {t("settingsTailscale.serve.openUrl")}
              </a>
            </>
          ) : (
            t("settingsTailscale.lock.rows.notOnTailnetNoUrl")
          )}
        </Row>
        <Row ok={false}>{t("settingsTailscale.lock.rows.serveOnIp", { port: access.panelPort })}</Row>
        <Row ok={false}>
          {access.agentPort === null
            ? t("settingsTailscale.lock.rows.agentPortOff")
            : onAgentPort
              ? t("settingsTailscale.lock.rows.agentPortStays", { port: access.agentPort, count: onAgentPort.nodeIds?.length ?? 1 })
              : t("settingsTailscale.lock.rows.agentPortCloses", { port: access.agentPort })}
        </Row>
        {domain ? (
          <li className="flex items-start gap-2 text-[13px]">
            <Checkbox
              id="lock-remove-domain"
              checked={removeDomain}
              onCheckedChange={(v) => setRemoveDomain(v === true)}
              className="mt-0.5"
            />
            <label htmlFor="lock-remove-domain" className="flex cursor-pointer flex-col gap-0.5">
              <span className="text-ink-strong">{t("settingsTailscale.lock.rows.domain", { domain })}</span>
              <span className="text-xs text-muted-foreground">{t("settingsTailscale.lock.rows.domainHint")}</span>
            </label>
          </li>
        ) : (
          <Row ok>{t("settingsTailscale.lock.rows.noDomain")}</Row>
        )}
      </ul>

      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-[13.5px] font-semibold">{t("settingsTailscale.lock.recoveryTitle")}</h3>
        <p className="m-0 text-[12.5px] text-muted-foreground">{t("settingsTailscale.lock.recoveryHint")}</p>
        <CodeBlock title={t("settingsTailscale.lock.sshTunnel", { port: access.panelPort })} code={access.recovery.sshTunnel} tone="dark" />
        <CodeBlock title={t("settingsTailscale.lock.reopenCli")} code={access.recovery.cli} tone="dark" />
        <CodeBlock title={t("settingsTailscale.lock.statusCli")} code={commands.status} tone="dark" />
        <div className="flex items-center gap-2">
          <Checkbox id="lock-saved" checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
          <label htmlFor="lock-saved" className="cursor-pointer text-[13px] text-ink-strong">
            {t("settingsTailscale.lock.saved")}
          </label>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="m-0 text-[13.5px] font-semibold">{t("settingsTailscale.lock.warningsTitle")}</h3>
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[12.5px] text-muted-foreground">
          <li>{t("settingsTailscale.lock.warnings.webhooks")}</li>
          <li>{t("settingsTailscale.lock.warnings.apiKeys", { port: access.panelPort })}</li>
          <li>{t("settingsTailscale.lock.warnings.passkeys")}</li>
          <li>{t("settingsTailscale.lock.warnings.alerts")}</li>
        </ul>
      </div>

      {access.blocked.length > 0 && (
        <Alert tone="neutral" title={t("settingsTailscale.lock.blockedTitle")}>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {access.blocked.map((block) => (
              <li key={`${block.code}-${block.message}`}>{block.message}</li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="flex justify-end">
        <Button variant="primary" disabled={!ready || !saved || update.isPending} onClick={() => setConfirm(true)}>
          {t("settingsTailscale.lock.button")}
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        destructive
        title={t("settingsTailscale.lock.confirmTitle")}
        description={t("settingsTailscale.lock.confirm", { port: access.panelPort })}
        confirmLabel={t("settingsTailscale.lock.button")}
        onConfirm={lock}
      />
    </>
  );
}

function Locked({ access, domain }: { access: PanelAccess; domain: string | null }) {
  return (
    <div className="flex flex-col items-start gap-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={access.actual.ip === "closed" ? "green" : "amber"}>{t("settingsTailscale.lock.title")}</Chip>
        <span className="text-ink-strong">
          {access.actual.ip === "closed"
            ? t("settingsTailscale.lock.locked", { domain: domain ? t("settingsTailscale.lock.lockedDomain", { domain }) : "" })
            : t("settingsTailscale.lock.lockedOpen")}
        </span>
      </div>
      {access.lastChange && access.actual.ip !== "closed" && <span className="text-muted-foreground">{access.lastChange.reason}</span>}
      <span className="text-muted-foreground">
        {t("settingsTailscale.lock.reopenHint")}{" "}
        <Link to="/settings/general" className="text-link hover:text-link-hover">
          {t("settingsTailscale.lock.openGeneral")}
        </Link>
      </span>
    </div>
  );
}
