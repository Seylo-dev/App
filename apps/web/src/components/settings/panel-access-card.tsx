// Settings > General > Panel domain: the domain and its status (when it
// was checked, "Check now", Cloudflare's proxy), and panel access (added
// in 0.2.1): "Serve on IP address" and "Agents' port" (each turn off asks
// first, each change restarts the panel), what happens when the domain
// stops working, and the commands that get the owner back in.
// The panel decides and refuses (settings.panelAccess / updatePanelAccess);
// the card shows its reasons and never guesses. Removing or changing a
// domain that nodes connect over (settings.general domainNodes) asks first
// and names them: they go offline.

import { nodes, type OpOutput, settings } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Chip } from "@seylo/ui/components/chip";
import { CodeBlock } from "@seylo/ui/components/code-block";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { CopyField } from "@seylo/ui/components/copy-field";
import { Input } from "@seylo/ui/components/input";
import { RadioCard, RadioGroup } from "@seylo/ui/components/radio-group";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { Switch } from "@seylo/ui/components/switch";
import { IconRefresh } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { t } from "../../i18n/t";
import { formatAgo, formatExpiresIn, formatNames } from "../../lib/format";
import { isReauthCancelled } from "../../lib/reauth";
import { useNow } from "../service/use-now";
import { useSettingsMutation } from "./mutation";
import { QueryView } from "./op-state";
import { Field, SettingRow } from "./page";

type General = OpOutput<typeof settings.general>;
type PanelAccess = OpOutput<typeof settings.panelAccess>;
type Block = PanelAccess["blocked"][number];

const hostnamePattern = new RegExp(settings.Hostname.pattern ?? ".*");

const domainTones = {
  none: "gray",
  pending_dns: "amber",
  issuing_certificate: "blue",
  active: "green",
  error: "red",
} as const;

/** Refusals about who is asking: the "keep it closed" choice has them too. */
const callerCodes: ReadonlySet<Block["code"]> = new Set(["notOwner", "notBrowserSession"]);

export function PanelDomainCard({ general }: { general: General }) {
  const access = useOp(settings.panelAccess, {});
  return (
    <SectionCard title={t("settings.general.domainCard.title")} description={t("settings.general.domainCard.description")}>
      <DomainForm key={general.domain ?? ""} general={general} access={access.data} />
      <QueryView query={access} skeleton={<AccessSkeleton />} className="flex flex-col gap-3">
        {(data) => <AccessControls access={data} domain={general.domain} />}
      </QueryView>
    </SectionCard>
  );
}

/**
 * What changing the domain does to IP access, the way updateGeneral decides
 * it: closed IP access reopens, unless it is set to stay closed; and while
 * the domain is the only way in that works, keep-closed refuses the change.
 */
function domainChange(access: PanelAccess | undefined): "open" | "reopens" | "staysClosed" | "refused" {
  if (access?.actual.ip !== "closed") return "open";
  if (access.onFailure !== "stayClosed") return "reopens";
  const domainWorks = access.privatePaths.some((path) => path.kind === "domain" && path.working);
  const otherWorks = access.privatePaths.some((path) => path.kind !== "domain" && path.working);
  return domainWorks && !otherWorks ? "refused" : "staysClosed";
}

const domainHints = {
  open: "settings.general.domainHint",
  reopens: "settings.general.domainCard.removeReopens",
  staysClosed: "settings.general.domainCard.domainStaysClosed",
  refused: "settings.general.domainCard.domainLocked",
} as const;

function DomainForm({ general, access }: { general: General; access: PanelAccess | undefined }) {
  const [domain, setDomain] = useState(general.domain ?? "");
  // The domain to save once the person confirmed that the nodes on the current one go offline.
  const [asking, setAsking] = useState<{ domain: string | null } | null>(null);
  const options = { invalidates: [settings.general, settings.panelAccess, settings.boot], success: t("settings.saved") };
  const save = useSettingsMutation(settings.updateGeneral, options);
  // The dialog shows a refusal itself.
  const confirmed = useSettingsMutation(settings.updateGeneral, { ...options, failure: false });
  const trimmed = domain.trim().toLowerCase();
  const error = trimmed !== "" && !hostnamePattern.test(trimmed) ? t("settings.general.domainInvalid") : null;
  const dirty = (trimmed || null) !== general.domain;
  const busy = save.isPending || confirmed.isPending;
  const change = domainChange(access);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (error || change === "refused") return;
    const next = trimmed === "" ? null : trimmed;
    if (general.domain && general.domainNodes.length > 0) setAsking({ domain: next });
    else save.mutate({ domain: next });
  }

  return (
    <>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label={t("settings.general.domain")} hint={t(domainHints[change])} error={error} htmlFor="general-domain">
          <div className="flex flex-wrap gap-2">
            <Input
              id="general-domain"
              value={domain}
              placeholder="panel.example.com"
              className="min-w-0 flex-1 font-mono text-[12.5px]"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setDomain(e.target.value)}
            />
            <Button type="submit" variant="primary" disabled={!dirty || busy || !!error || change === "refused"}>
              {busy ? t("settings.saving") : t("settings.general.domainCard.saveDomain")}
            </Button>
          </div>
        </Field>
        <DomainState general={general} dirty={dirty} />
        {general.domainStatus.message && (
          <p data-testid="domain-message" className="m-0 text-[12.5px] text-muted-foreground">
            {general.domainStatus.message}
          </p>
        )}
        <CopyField value={general.publicUrl} aria-label={t("settings.general.publicUrl")} />
        <p className="m-0 text-[12.5px] text-muted-foreground">
          {t("settings.general.updatesHint")}{" "}
          <Link to="/settings/updates" className="text-link hover:text-link-hover">
            {t("settings.sections.updates")}
          </Link>
        </p>
      </form>
      <NodesOfflineDialog
        general={general}
        asking={asking}
        onClose={() => setAsking(null)}
        onConfirm={(next) => confirmed.mutateAsync({ domain: next, acknowledgeNodesOffline: true })}
      />
    </>
  );
}

/** Asks before removing or changing a domain that nodes connect over. Kept out of the domain form: React bubbles the dialog's own submit through the portal. */
function NodesOfflineDialog({
  general,
  asking,
  onClose,
  onConfirm,
}: {
  general: General;
  asking: { domain: string | null } | null;
  onClose: () => void;
  onConfirm: (domain: string | null) => Promise<unknown>;
}) {
  return (
    <ConfirmDialog
      open={asking !== null}
      onOpenChange={(open) => !open && onClose()}
      destructive
      title={t(asking?.domain ? "settings.general.domainCard.changeTitle" : "settings.general.domainCard.removeTitle")}
      description={t("settings.general.domainCard.nodesOffline", {
        nodes: formatNames(general.domainNodes.map((node) => node.name)),
        domain: general.domain ?? "",
        count: general.domainNodes.length,
      })}
      confirmLabel={t(asking?.domain ? "settings.general.domainCard.changeConfirm" : "settings.general.domainCard.removeConfirm")}
      onConfirm={async () => {
        await onConfirm(asking?.domain ?? null);
      }}
    />
  );
}

/**
 * The domain's state, Cloudflare's proxy when every record is one of its
 * addresses, when it was last checked, and "Check now" (the panel allows
 * one check per 10 seconds and answers with the fresh state; scheduled
 * checks refresh the card over the live socket).
 */
function DomainState({ general, dirty }: { general: General; dirty: boolean }) {
  const status = general.domainStatus;
  const now = useNow(30_000);
  const check = useSettingsMutation(settings.checkDomain, { invalidates: [settings.general, settings.panelAccess] });
  const checkedAt = status.checkedAt;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[13px] font-medium text-ink-strong">{t("settings.general.domainState")}</span>
      <Chip tone={domainTones[status.state]}>{t(`settings.general.domainStates.${status.state}`)}</Chip>
      {status.proxied && <Chip tone="gray">{t("settings.general.domainCard.proxied")}</Chip>}
      {checkedAt && (
        <span data-testid="domain-checked" className="text-[12.5px] text-muted-foreground">
          {now - Date.parse(checkedAt) < 60_000
            ? t("settings.general.domainCard.checkedJustNow")
            : t("settings.general.domainCard.checked", { when: formatAgo(checkedAt, now) })}
        </span>
      )}
      {general.domain && (
        <Button
          type="button"
          size="sm"
          className="ml-auto bg-muted shadow-none"
          // A typed but unsaved domain is not what the panel checks: Save domain checks it.
          disabled={check.isPending || dirty}
          onClick={() => check.mutate({})}
        >
          <IconRefresh size={15} stroke={1.8} />
          {check.isPending ? t("settings.general.domainCard.checking") : t("settings.general.domainCard.checkNow")}
        </Button>
      )}
    </div>
  );
}

/** http://<panel node address>:<panel port>, the address IP access is about. */
function useIpUrl(port: number): string {
  const list = useOp(nodes.list, {});
  const node = list.data?.nodes.find((n) => n.isPanelNode);
  const address = node?.publicAddress || node?.publicIpv4 || node?.publicIpv6 || null;
  const host = address ? (address.includes(":") && !address.startsWith("[") ? `[${address}]` : address) : "<server-ip>";
  return `http://${host}:${port}`;
}

function AccessControls({ access, domain }: { access: PanelAccess; domain: string | null }) {
  const ipUrl = useIpUrl(access.panelPort);
  const domainUrl = domain ? `https://${domain}` : (access.privatePaths.find((p) => p.working)?.url ?? "");
  const [confirm, setConfirm] = useState<"ip" | "agentPort" | null>(null);
  const save = useSettingsMutation(settings.updatePanelAccess, {
    invalidates: [settings.panelAccess, settings.general],
    success: t("settings.general.domainCard.saved"),
  });
  // Turning off goes through a dialog, which shows a refusal itself.
  const close = useSettingsMutation(settings.updatePanelAccess, {
    invalidates: [settings.panelAccess, settings.general],
    success: t("settings.general.domainCard.saved"),
    failure: false,
  });
  const busy = save.isPending || close.isPending;
  const pending = save.isPending ? save.variables : close.isPending ? close.variables : undefined;
  const turnOff = async (input: { serveOnIp?: false; agentPortOpen?: false }) => {
    try {
      await close.mutateAsync(input);
    } catch (error) {
      // The person closed the re-auth dialog: nothing failed, close this one too.
      if (isReauthCancelled(error)) return;
      throw error;
    }
  };
  const serveOnIp = pending?.serveOnIp ?? access.serveOnIp;
  const agentPortOpen = pending?.agentPortOpen ?? access.agentPortOpen;
  const ipLocked = serveOnIp && access.blocked.length > 0;
  const agentLocked = agentPortOpen && (serveOnIp || access.agentPortBlocked.length > 0);
  const callerBlocked = access.blocked.some((block) => callerCodes.has(block.code));

  return (
    <>
      {access.privatePaths.length > 0 && <PrivatePaths paths={access.privatePaths} />}
      <div className="flex flex-col">
        <SettingRow
          title={t("settings.general.domainCard.serveOnIp")}
          description={t("settings.general.domainCard.serveOnIpHint", { url: ipUrl })}
          control={
            <Switch
              checked={serveOnIp}
              disabled={busy || ipLocked}
              onCheckedChange={(on) => (on ? save.mutate({ serveOnIp: true }) : setConfirm("ip"))}
              aria-label={t("settings.general.domainCard.serveOnIp")}
            />
          }
        />
        {serveOnIp && access.blocked.length > 0 && <Blocks title={t("settings.general.domainCard.blockedTitle")} blocks={access.blocked} />}
        <IpState access={access} ipUrl={ipUrl} />
        {access.oldDocker && !serveOnIp && (
          <Alert tone="warning" className="mb-3">
            {t("settings.general.domainCard.oldDocker", { version: access.oldDocker })}
          </Alert>
        )}

        {access.agentPort === null ? (
          <SettingRow
            title={t("settings.general.domainCard.agentPort")}
            description={t("settings.general.domainCard.agentPortNone")}
            control={null}
          />
        ) : (
          <SettingRow
            title={t("settings.general.domainCard.agentPort")}
            description={
              serveOnIp && agentPortOpen
                ? t("settings.general.domainCard.agentPortNeedsIpOff")
                : t("settings.general.domainCard.agentPortHint", { port: access.agentPort })
            }
            control={
              <Switch
                checked={agentPortOpen}
                disabled={busy || agentLocked}
                onCheckedChange={(on) => (on ? save.mutate({ agentPortOpen: true }) : setConfirm("agentPort"))}
                aria-label={t("settings.general.domainCard.agentPort")}
              />
            }
          />
        )}
        {/* The IP list above only shows while Serve on IP address is on, so this one has every reason. */}
        {!serveOnIp && agentPortOpen && access.agentPortBlocked.length > 0 && (
          <Blocks title={t("settings.general.domainCard.agentPortBlockedTitle")} blocks={access.agentPortBlocked} />
        )}
        <AgentPortState access={access} wantedOpen={agentPortOpen} />
      </div>

      <OnFailure
        key={access.onFailure}
        access={access}
        saving={busy}
        callerBlocked={callerBlocked}
        onSave={(input) => save.mutate(input)}
      />
      <Recovery access={access} />

      <ConfirmDialog
        open={confirm === "ip"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t("settings.general.domainCard.confirmCloseTitle")}
        description={t("settings.general.domainCard.confirmCloseDescription", { url: ipUrl })}
        confirmLabel={t("settings.general.domainCard.confirmClose")}
        // API keys, the CLI and scripts on the IP address stop working: the same weight as a revoke.
        destructive
        onConfirm={() => turnOff({ serveOnIp: false })}
      >
        <Alert tone="warning">{t("settings.general.domainCard.confirmCloseWarning", { url: ipUrl, domain: domainUrl })}</Alert>
        {access.oldDocker && <Alert tone="warning">{t("settings.general.domainCard.oldDocker", { version: access.oldDocker })}</Alert>}
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] text-muted-foreground">{t("settings.general.domainCard.confirmCloseSsh")}</span>
          <CodeBlock code={access.recovery.sshTunnel} tone="dark" />
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "agentPort"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t("settings.general.domainCard.confirmAgentTitle")}
        description={t("settings.general.domainCard.confirmAgentDescription", { domain: domainUrl })}
        confirmLabel={t("settings.general.domainCard.confirmAgent")}
        destructive
        onConfirm={() => turnOff({ agentPortOpen: false })}
      />
    </>
  );
}

function PrivatePaths({ paths }: { paths: PanelAccess["privatePaths"] }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-control bg-raised px-3 py-2.5">
      <span className="text-[12.5px] font-medium text-ink-strong">{t("settings.general.domainCard.paths")}</span>
      {paths.map((path) => (
        <div key={path.kind} className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">{t(`settings.general.domainCard.pathKinds.${path.kind}`)}</span>
          <span className="min-w-0 break-all font-mono text-[12.5px]">{path.url}</span>
          <Chip tone={path.working ? "green" : "amber"}>
            {path.working ? t("settings.general.domainCard.pathWorking") : t("settings.general.domainCard.pathDown")}
          </Chip>
          {path.usingNow && <Chip tone="blue">{t("settings.general.domainCard.youAreHere")}</Chip>}
        </div>
      ))}
    </div>
  );
}

function Blocks({ title, blocks }: { title: string; blocks: readonly Block[] }) {
  if (blocks.length === 0) return null;
  return (
    <Alert tone="neutral" title={title} className="mb-3">
      <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
        {blocks.map((block) => (
          <li key={`${block.code}:${block.message}`}>{block.message}</li>
        ))}
      </ul>
    </Alert>
  );
}

/** The agents' port as it runs: closed, or open although it is turned off (and why). */
function AgentPortState({ access, wantedOpen }: { access: PanelAccess; wantedOpen: boolean }) {
  if (access.actual.agentPort === "closed") {
    return <p className="m-0 pb-3 text-[12.5px] text-muted-foreground">{t("settings.general.domainCard.agentPortClosedNow")}</p>;
  }
  if (wantedOpen || access.actual.agentPort !== "open") return null;
  // It only closes with IP access, and only while every node connects over the domain.
  const onAgentPort = access.agentPortBlocked.filter((block) => block.code === "nodesOnAgentPort");
  if (access.actual.ip === "closed" && onAgentPort.length > 0) {
    return <Blocks title={t("settings.general.domainCard.agentPortBlockedTitle")} blocks={onAgentPort} />;
  }
  return (
    <p className="m-0 pb-3 text-[12.5px] text-muted-foreground">
      {access.actual.ip === "closed"
        ? t("settings.general.domainCard.agentPortOpenNow")
        : t("settings.general.domainCard.agentPortOpenWithIp")}
    </p>
  );
}

/** What runs now, when it differs from "open as chosen": closed, restarting, or reopened by itself. */
function IpState({ access, ipUrl }: { access: PanelAccess; ipUrl: string }) {
  const lines: string[] = [];
  if (access.actual.ip === "unknown" || access.actual.agentPort === "unknown") lines.push(t("settings.general.domainCard.restarting"));
  else if (access.actual.ip === "closed") lines.push(t("settings.general.domainCard.closedNow", { url: ipUrl }));
  else if (!access.serveOnIp && (access.openReason || access.lastChange)) {
    lines.push(t("settings.general.domainCard.reopenedNow", { reason: access.openReason ?? access.lastChange?.reason ?? "" }));
  }
  if (access.reclosesAt) lines.push(t("settings.general.domainCard.reclosesAt", { when: formatExpiresIn(access.reclosesAt) }));
  if (access.lastChange && (access.actual.ip === "closed" || access.serveOnIp)) {
    lines.push(
      access.lastChange.by === "system"
        ? t("settings.general.domainCard.lastChange", { when: formatAgo(access.lastChange.at), reason: access.lastChange.reason })
        : t("settings.general.domainCard.lastChangeBy", {
            when: formatAgo(access.lastChange.at),
            reason: access.lastChange.reason,
            by: access.lastChange.by,
          }),
    );
  }
  if (lines.length === 0) return null;
  return (
    <div data-testid="ip-access-state" className="flex flex-col gap-0.5 pb-3 text-[12.5px] text-muted-foreground">
      {lines.map((line) => (
        <p key={line} className="m-0">
          {line}
        </p>
      ))}
    </div>
  );
}

function OnFailure({
  access,
  saving,
  callerBlocked,
  onSave,
}: {
  access: PanelAccess;
  saving: boolean;
  callerBlocked: boolean;
  onSave: (input: { onFailure: PanelAccess["onFailure"]; savedRecovery?: boolean }) => void;
}) {
  // Keyed by the saved choice: a save (here or elsewhere) starts it over.
  const [choice, setChoice] = useState(access.onFailure);
  const [saved, setSaved] = useState(false);
  const tickId = useId();
  const confirming = choice === "stayClosed" && access.onFailure !== "stayClosed";

  return (
    <div className="flex flex-col gap-2 border-t border-divider pt-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-[13.5px] font-medium">{t("settings.general.domainCard.onFailureTitle")}</span>
        <span className="text-[12.5px] text-muted-foreground">{t("settings.general.domainCard.onFailureHint")}</span>
      </div>
      <RadioGroup
        value={choice}
        onValueChange={(value) => {
          const next = value as PanelAccess["onFailure"];
          setChoice(next);
          setSaved(false);
          if (next === "reopen" && access.onFailure !== "reopen") onSave({ onFailure: "reopen" });
        }}
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        aria-label={t("settings.general.domainCard.onFailureTitle")}
      >
        <RadioCard
          value="reopen"
          title={t("settings.general.domainCard.reopen")}
          description={t("settings.general.domainCard.reopenHint")}
          disabled={saving}
        />
        <RadioCard
          value="stayClosed"
          title={t("settings.general.domainCard.stayClosed")}
          description={callerBlocked ? t("settings.general.domainCard.ownerOnly") : t("settings.general.domainCard.stayClosedHint")}
          disabled={saving || (callerBlocked && access.onFailure !== "stayClosed")}
        />
      </RadioGroup>
      {confirming && (
        <div className="flex flex-wrap items-center gap-3 rounded-control bg-raised px-3 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Checkbox id={tickId} checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
            <label htmlFor={tickId} className="cursor-pointer text-[13px] text-ink-strong">
              {t("settings.general.domainCard.savedRecovery")}
            </label>
          </div>
          <Button
            variant="primary"
            size="sm"
            disabled={!saved || saving}
            onClick={() => onSave({ onFailure: "stayClosed", savedRecovery: true })}
          >
            {t("settings.general.domainCard.keepClosed")}
          </Button>
        </div>
      )}
    </div>
  );
}

function Recovery({ access }: { access: PanelAccess }) {
  return (
    <div className="flex flex-col gap-2 border-t border-divider pt-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-[13.5px] font-medium">{t("settings.general.domainCard.recoveryTitle")}</span>
        <span className="text-[12.5px] text-muted-foreground">
          {access.onFailure === "stayClosed"
            ? t("settings.general.domainCard.recoveryKeptClosed")
            : t("settings.general.domainCard.recoveryHint")}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] text-muted-foreground">{t("settings.general.domainCard.recoverySsh")}</span>
        <CodeBlock code={access.recovery.sshTunnel} tone="dark" />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] text-muted-foreground">{t("settings.general.domainCard.recoveryCli")}</span>
        <CodeBlock code={access.recovery.cli} tone="dark" />
      </div>
    </div>
  );
}

function AccessSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <div className="flex flex-1 flex-col gap-1.5">
          <SkeletonText className="w-36 text-[13.5px]" />
          <SkeletonText className="w-72 text-[12.5px]" />
        </div>
        <Skeleton className="h-5 w-9 rounded-full" />
      </div>
      <div className="flex items-center gap-4">
        <div className="flex flex-1 flex-col gap-1.5">
          <SkeletonText className="w-28 text-[13.5px]" />
          <SkeletonText className="w-64 text-[12.5px]" />
        </div>
        <Skeleton className="h-5 w-9 rounded-full" />
      </div>
    </div>
  );
}
