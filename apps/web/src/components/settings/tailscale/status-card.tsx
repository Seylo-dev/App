// Settings > Tailscale, first card: what the panel server's agent sees of
// the server's own tailscaled. Not found: the Install button (the panel
// node's Shell tab with the command typed in) and the command to copy. Not
// signed in: Sign in to Tailscale (the link opens in a new tab). Needs
// approval: the admin console. Signed in but not on the tailnet yet
// (Starting): Connecting. Running: the tailnet, the machine, key expiry,
// HTTPS and MagicDNS, the warnings, and the access rule to paste. While the
// agent is offline the card shows its last report, and the buttons that
// need the agent are disabled.

import { nodes, tailscale } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { CodeBlock, CopyCode } from "@seylo/ui/components/code-block";
import { KeyValue, type KeyValueItem } from "@seylo/ui/components/key-value";
import { SectionCard } from "@seylo/ui/components/section-card";
import { toast } from "@seylo/ui/components/toast";
import { IconExternalLink } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../../i18n/t";
import { formatDate } from "../format";
import { invalidateOps } from "../mutation";
import { toastError } from "../op-state";
import { adminConsole, commands, installShellSearch, isConnecting, isSignedOut, type TailscaleStatus } from "./shared";

const keyExpirySoonMs = 14 * 86_400_000;

function External({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-link hover:text-link-hover">
      {children}
      <IconExternalLink size={13} stroke={1.9} aria-hidden="true" />
    </a>
  );
}

export function StatusCard({ status }: { status: TailscaleStatus }) {
  return (
    <SectionCard title={t("settingsTailscale.status.title")} description={t("settingsTailscale.status.description")}>
      {!status.agentOnline && (
        <Alert tone="neutral">
          {status.detected ? t("settingsTailscale.status.offline") : t("settingsTailscale.status.offlineNothing")}
        </Alert>
      )}
      {status.agentOnline && !status.agentSupported ? (
        <Alert
          tone="warning"
          action={
            <Button size="sm" asChild>
              <Link to="/nodes">{t("settingsTailscale.status.openNodes")}</Link>
            </Button>
          }
        >
          {t("settingsTailscale.status.agentTooOld")}
        </Alert>
      ) : (
        <StatusBody status={status} />
      )}
    </SectionCard>
  );
}

function StatusBody({ status }: { status: TailscaleStatus }) {
  if (!status.detected) return status.agentSupported ? <NotFound status={status} /> : null;
  return (
    <>
      {status.disabledOnServer && (
        <Alert tone="warning">
          <span className="flex flex-col items-start gap-1.5">
            {t("settingsTailscale.status.disabledOnServer")}
            <CopyCode code={commands.allowOnServer} />
          </span>
        </Alert>
      )}
      {!status.versionOk && (
        <Alert tone="warning">{t("settingsTailscale.status.tooOld", { version: status.version ?? "?", min: status.minVersion })}</Alert>
      )}
      {status.backendState === "NeedsMachineAuth" ? (
        <NeedsApproval />
      ) : isSignedOut(status) ? (
        <SignedOut status={status} />
      ) : isConnecting(status) ? (
        <Connecting />
      ) : (
        <Running status={status} />
      )}
    </>
  );
}

function NotFound({ status }: { status: TailscaleStatus }) {
  const list = useOp(nodes.list, {});
  const panelNode = list.data?.nodes.find((node) => node.isPanelNode) ?? null;
  return (
    <div className="flex flex-col items-start gap-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Chip tone="gray">{t("settingsTailscale.status.notFound")}</Chip>
        <span className="text-muted-foreground">{t("settingsTailscale.status.notFoundHint")}</span>
      </div>
      {status.canManage && panelNode && (
        <div className="flex flex-col items-start gap-1.5">
          <Button variant="primary" asChild>
            <Link to="/nodes" search={installShellSearch(panelNode.id)}>
              {t("settingsTailscale.status.install")}
            </Link>
          </Button>
          <span className="text-xs text-muted-foreground">{t("settingsTailscale.status.installHint")}</span>
        </div>
      )}
      <div className="flex w-full flex-col gap-1.5">
        <span className="text-[12.5px] text-ink-strong">{t("settingsTailscale.status.installSsh")}</span>
        <CodeBlock code={status.installCommand} tone="dark" />
      </div>
      <p className="m-0 text-[12.5px] text-muted-foreground">{t("settingsTailscale.status.firewall")}</p>
    </div>
  );
}

function SignedOut({ status }: { status: TailscaleStatus }) {
  const signIn = useOpMutation(tailscale.signIn, {
    onSuccess: async (out) => {
      window.open(out.url, "_blank", "noopener,noreferrer");
      await invalidateOps([tailscale.get]);
    },
    onError: (error) => toastError(error),
  });
  const stopped = status.backendState === "Stopped";
  return (
    <div className="flex flex-col items-start gap-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Chip tone="amber">{stopped ? t("settingsTailscale.status.stopped") : t("settingsTailscale.status.notSignedIn")}</Chip>
        <span className="text-muted-foreground">
          {stopped ? t("settingsTailscale.status.stoppedHint") : t("settingsTailscale.status.notSignedInHint")}
        </span>
      </div>
      {status.canManage ? (
        // The panel refuses it while the agent is offline (the alert above says so).
        <Button variant="primary" disabled={signIn.isPending || !status.agentOnline} onClick={() => signIn.mutate({})}>
          {signIn.isPending ? t("settingsTailscale.status.signingIn") : t("settingsTailscale.status.signIn")}
        </Button>
      ) : (
        <span className="text-[12.5px] text-ink-strong">{t("settingsTailscale.status.ownerOnly")}</span>
      )}
      {status.signInUrl && (
        <div className="flex flex-col items-start gap-0.5 text-[13px]">
          <External href={status.signInUrl}>{t("settingsTailscale.status.signInLink")}</External>
          <span className="text-xs text-muted-foreground">{t("settingsTailscale.status.signInLinkHint")}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-strong">
        {t("settingsTailscale.status.signInSsh")}
        <CopyCode code={commands.signIn} />
      </div>
    </div>
  );
}

/** Signed in, but tailscaled has not reached the tailnet yet (BackendState Starting). */
function Connecting() {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <Chip tone="blue">{t("settingsTailscale.status.connecting")}</Chip>
      <span className="text-muted-foreground">{t("settingsTailscale.status.connectingHint")}</span>
    </div>
  );
}

function NeedsApproval() {
  return (
    <div className="flex flex-col items-start gap-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="amber">{t("settingsTailscale.status.needsApproval")}</Chip>
        <span className="text-muted-foreground">{t("settingsTailscale.status.needsApprovalHint")}</span>
      </div>
      <External href={adminConsole.machines}>{t("settingsTailscale.status.openMachines")}</External>
    </div>
  );
}

function Running({ status }: { status: TailscaleStatus }) {
  const setDns = useOpMutation(tailscale.setDns, {
    onSuccess: async () => {
      await invalidateOps([tailscale.get]);
      toast.success(t("settingsTailscale.status.dnsOff"));
    },
    onError: (error) => toastError(error),
  });
  const machine = status.dnsName ?? "?";
  const expiry = status.keyExpiry ? Date.parse(status.keyExpiry) : null;
  const items: KeyValueItem[] = [
    { label: t("settingsTailscale.status.tailnet"), value: status.tailnet ?? "?" },
    { label: t("settingsTailscale.status.machine"), value: machine, mono: true },
    { label: t("settingsTailscale.status.addresses"), value: status.addresses.join(", ") || "?", mono: true },
    status.loginName
      ? { label: t("settingsTailscale.status.owner"), value: status.loginName }
      : { label: t("settingsTailscale.status.tags"), value: status.tags.join(", ") || "?", mono: true },
    { label: t("settingsTailscale.status.version"), value: status.version ?? "?", mono: true },
    {
      label: t("settingsTailscale.status.keyExpiry"),
      value: (
        <span className="flex flex-wrap items-center gap-x-2">
          {status.keyExpiry
            ? t("settingsTailscale.status.keyExpires", { date: formatDate(status.keyExpiry) })
            : t("settingsTailscale.status.keyNeverExpires")}
          {status.keyExpiry && <External href={adminConsole.machines}>{t("settingsTailscale.status.disableKeyExpiry")}</External>}
        </span>
      ),
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Chip tone="green">{t("settingsTailscale.status.running")}</Chip>
        <span className="text-ink-strong">{t("settingsTailscale.status.signedInAs", { tailnet: status.tailnet ?? "?", machine })}</span>
        {status.https && <Chip tone="green">{t("settingsTailscale.status.httpsOn")}</Chip>}
      </div>
      <KeyValue items={items} layout="grid" />
      {expiry !== null && expiry - Date.now() < keyExpirySoonMs && (
        <Alert tone="warning">{t("settingsTailscale.status.keyExpirySoon", { date: formatDate(expiry) })}</Alert>
      )}
      {!status.magicDns && (
        <Alert tone="warning" action={<External href={adminConsole.dns}>{t("settingsTailscale.status.turnOnMagicDns")}</External>}>
          {t("settingsTailscale.status.magicDnsOff")}
        </Alert>
      )}
      {!status.https && (
        <Alert tone="info" action={<External href={adminConsole.dns}>{t("settingsTailscale.status.turnOnHttps")}</External>}>
          {t("settingsTailscale.status.httpsOff")}
        </Alert>
      )}
      {status.acceptDns && (
        <Alert
          tone="warning"
          action={
            status.canManage && (
              <Button size="sm" disabled={setDns.isPending || !status.agentOnline} onClick={() => setDns.mutate({ acceptDns: false })}>
                {t("settingsTailscale.status.turnOffDns")}
              </Button>
            )
          }
        >
          {t("settingsTailscale.status.acceptDns")}
        </Alert>
      )}
      {status.exitNodeInUse && <Alert tone="warning">{t("settingsTailscale.status.exitNode")}</Alert>}
      {status.advertisesRoutes && <Alert tone="info">{t("settingsTailscale.status.routes")}</Alert>}
      {status.grantSnippet && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 text-[13.5px] font-semibold">{t("settingsTailscale.status.accessTitle")}</h3>
            <External href={adminConsole.acls}>{t("settingsTailscale.status.openAccessControls")}</External>
          </div>
          <p className="m-0 text-[12.5px] text-muted-foreground">{t("settingsTailscale.status.access")}</p>
          <CodeBlock code={status.grantSnippet} title="policy.hujson" />
        </div>
      )}
    </div>
  );
}
