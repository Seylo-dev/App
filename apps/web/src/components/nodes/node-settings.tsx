// Node settings in the node sheet. Each group saves on its own op:
// rename, tags, the general settings (location, wildcard domain, parallel
// builds, log retention), the can-build switch and games-first CPU (only
// when Wings is detected), the Panel address (follow the panel's domain or
// stay on the node's address; not on the panel node), and removing the
// node. A location the panel
// detected from the node's address is marked Detected until the form is
// saved, which makes it the owner's (locationSource "manual"). Builds at
// once is Auto (sized from the node's cores and memory, autoParallelBuilds
// in @seylo/ops) or a fixed number from 1 to 16.

import { slug } from "@seylo/brand";
import { autoParallelBuilds, maxParallelBuildsLimit, nodes } from "@seylo/ops";
import { opQueryKey, useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { CopyCode } from "@seylo/ui/components/code-block";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { Input, Label } from "@seylo/ui/components/input";
import { RadioCard, RadioGroup } from "@seylo/ui/components/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { type MessageKey, t } from "../../i18n/t";
import { errorMessage, queryClient } from "../../lib/api";
import type { NodeDetail } from "../../lib/types";

const mib = 1024 * 1024;

/** The Builds at once choice that is not a number. */
const autoBuilds = "auto";
const buildCounts = Array.from({ length: maxParallelBuildsLimit }, (_, i) => String(i + 1));

/** What Save sends for Builds at once: Auto without a number, or a number alone, which makes it fixed (Auto off). */
export function parallelBuildsInput(choice: string): { parallelBuildsAuto: true } | { maxParallelBuilds: number } {
  return choice === autoBuilds ? { parallelBuildsAuto: true } : { maxParallelBuilds: Number(choice) };
}

function refresh(nodeId: string) {
  void queryClient.invalidateQueries({ queryKey: opQueryKey(nodes.get, { nodeId }) });
  void queryClient.invalidateQueries({ queryKey: opQueryKey(nodes.list) });
}

export function NodeSettingsForm({ node, onRemoved }: { node: NodeDetail; onRemoved: () => void }) {
  const [name, setName] = useState(node.name);
  const [location, setLocation] = useState(node.location ?? "");
  const [locationEdited, setLocationEdited] = useState(false);
  // A location the panel detects while the form is open shows up in it, unless the field was edited.
  useEffect(() => {
    if (!locationEdited) setLocation(node.location ?? "");
  }, [node.location, locationEdited]);
  // Detected from the node's address and not saved yet: marked until someone saves the form.
  const locationDetected = node.locationSource === "detected" && location === (node.location ?? "");
  const [publicAddress, setPublicAddress] = useState(node.publicAddress ?? "");
  const [tags, setTags] = useState(node.tags.join(", "));
  const [wildcard, setWildcard] = useState(node.wildcardDomain ?? "");
  const [parallel, setParallel] = useState(node.parallelBuildsAuto ? autoBuilds : String(node.maxParallelBuilds));
  // What Auto runs on this node now: the panel's own number while it is on, else the same formula on its facts.
  const autoNow = node.parallelBuildsAuto ? node.maxParallelBuilds : autoParallelBuilds(node.facts);
  const reportedHardware = Boolean(node.facts && node.facts.cpuCores > 0 && node.facts.memoryTotalBytes > 0);
  const autoLabel = t("nodes.form.parallelBuildsAuto", { builds: autoNow });
  const [logMb, setLogMb] = useState(String(Math.round(node.logRetention.maxBytesPerService / mib)));
  const [logDays, setLogDays] = useState(String(node.logRetention.maxAgeDays));
  const [removeOpen, setRemoveOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const done = () => {
    setError(null);
    toast.success(t("nodes.form.saved"));
    refresh(node.id);
  };
  const rename = useOpMutation(nodes.rename, { onError: setError });
  const setTagList = useOpMutation(nodes.setTags, { onError: setError });
  const update = useOpMutation(nodes.updateSettings, { onError: setError });
  const canBuild = useOpMutation(nodes.setCanBuild, { onSuccess: done, onError: setError });
  const gamesFirst = useOpMutation(nodes.setGamesFirstCpu, { onSuccess: done, onError: setError });
  const choose = useOpMutation(nodes.updateSettings, { onSuccess: done, onError: setError });
  const remove = useOpMutation(nodes.remove);
  const pending = rename.isPending || setTagList.isPending || update.isPending;

  // The A record needs an IPv4: the owner's address when it is one, else the detected one.
  const dnsIp = node.publicAddress && /^\d+\.\d+\.\d+\.\d+$/.test(node.publicAddress) ? node.publicAddress : node.publicIpv4;

  const tagList = tags
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      if (name.trim() !== node.name) await rename.mutateAsync({ nodeId: node.id, name: name.trim() });
      if (tagList.join(",") !== node.tags.join(",")) await setTagList.mutateAsync({ nodeId: node.id, tags: [...new Set(tagList)] });
      await update.mutateAsync({
        nodeId: node.id,
        location: location.trim() || null,
        publicAddress: publicAddress.trim() || null,
        wildcardDomain: wildcard.trim().replace(/^\*\./, "").toLowerCase() || null,
        ...parallelBuildsInput(parallel),
        logRetention: { maxBytesPerService: Number(logMb) * mib, maxAgeDays: Number(logDays) },
      });
      done();
    } catch {
      // Shown through setError by the failing mutation.
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="node-name" label="nodes.form.name" hint="nodes.form.nameHint">
            <Input
              id="node-name"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              maxLength={60}
              className="font-mono"
              required
            />
          </Field>
          <Field
            id="node-location"
            label="nodes.form.location"
            badge={
              locationDetected && (
                <Chip tone="sky" className="px-[7px] py-0 text-[11px]">
                  {t("nodes.form.locationDetected")}
                </Chip>
              )
            }
            note={locationDetected && <DetectedLocationHint />}
          >
            <Input
              id="node-location"
              value={location}
              onChange={(e) => {
                setLocationEdited(true);
                setLocation(e.target.value);
              }}
              maxLength={80}
              placeholder="Falkenstein, Germany"
              aria-describedby={locationDetected ? "node-location-note" : undefined}
            />
          </Field>
        </div>
        <Field id="node-public-address" label="nodes.form.publicAddress" hint="nodes.form.publicAddressHint">
          <Input
            id="node-public-address"
            value={publicAddress}
            onChange={(e) => setPublicAddress(e.target.value)}
            maxLength={253}
            placeholder={node.publicIpv4 ?? node.publicIpv6 ?? "203.0.113.7"}
            className="font-mono"
          />
        </Field>
        <Field id="node-tags" label="nodes.form.tags" hint="nodes.form.tagsHint">
          <Input id="node-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="eu, games" />
        </Field>
        <Field id="node-wildcard" label="nodes.form.wildcard" hint="nodes.form.wildcardHint">
          <WildcardInput id="node-wildcard" value={wildcard} onChange={setWildcard} />
        </Field>
        {wildcard.trim() && dnsIp && <DnsRecordLine record={`*.${wildcard.trim().replace(/^\*\./, "")} A ${dnsIp}`} />}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field
            id="node-parallel"
            label="nodes.form.parallelBuilds"
            hint={
              parallel !== autoBuilds
                ? undefined
                : reportedHardware
                  ? "nodes.form.parallelBuildsAutoHint"
                  : "nodes.form.parallelBuildsAutoNoFacts"
            }
          >
            <Select value={parallel} onValueChange={setParallel}>
              <SelectTrigger id="node-parallel" aria-describedby={parallel === autoBuilds ? "node-parallel-hint" : undefined}>
                <SelectValue>{parallel === autoBuilds ? autoLabel : parallel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={autoBuilds}>{autoLabel}</SelectItem>
                {buildCounts.map((count) => (
                  <SelectItem key={count} value={count}>
                    {count}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="node-log-mb" label="nodes.form.logSize">
            <Input id="node-log-mb" type="number" min={1} value={logMb} onChange={(e) => setLogMb(e.target.value)} />
          </Field>
          <Field id="node-log-days" label="nodes.form.logDays">
            <Input id="node-log-days" type="number" min={1} max={3650} value={logDays} onChange={(e) => setLogDays(e.target.value)} />
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" className="ml-auto" disabled={pending}>
            {t("common.save")}
          </Button>
        </div>
      </form>

      {error !== null && <Alert tone="danger">{errorMessage(error, t("common.unknownError"))}</Alert>}

      <div className="flex flex-col gap-3 border-t border-divider pt-4">
        <Toggle
          title="nodes.form.canBuild"
          hint={node.canBuildWarning ?? t("nodes.form.canBuildHint")}
          checked={node.canBuild}
          disabled={canBuild.isPending}
          onChange={(value) => canBuild.mutate({ nodeId: node.id, canBuild: value })}
        />
        {node.wings.detected && (
          <Toggle
            title="nodes.form.gamesFirst"
            hint={t("nodes.form.gamesFirstHint")}
            checked={node.gamesFirstCpu}
            disabled={gamesFirst.isPending}
            onChange={(value) => gamesFirst.mutate({ nodeId: node.id, enabled: value })}
          />
        )}
      </div>

      {node.panelAddressChoice && (
        <PanelAddressChoice
          node={node}
          pending={choose.isPending}
          onChange={(choice) => choose.mutate({ nodeId: node.id, panelAddressChoice: choice })}
        />
      )}

      <div className="flex flex-col gap-2 border-t border-divider pt-4">
        <h3 className="m-0 text-sm font-semibold text-chip-red-fg">{t("nodes.form.remove")}</h3>
        <p className="m-0 text-[12.5px] text-muted-foreground">
          {node.isPanelNode ? t("nodes.form.removePanelNode") : t("nodes.form.removeHint")}
        </p>
        <Button
          variant="destructive"
          size="sm"
          className="self-start"
          disabled={node.isPanelNode || node.services.length > 0}
          onClick={() => setRemoveOpen(true)}
        >
          {t("nodes.form.remove")}
        </Button>
      </div>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        destructive
        title={t("nodes.form.removeTitle", { name: node.name })}
        // The button only works once the node runs nothing, so the dialog leaves out the hint's "Move its services away first".
        description={t("nodes.form.removeConfirmHint")}
        confirmText={node.name}
        confirmLabel={t("nodes.form.remove")}
        onConfirm={async () => {
          await remove.mutateAsync({ nodeId: node.id, confirmName: node.name });
          toast.success(t("nodes.form.removed", { name: node.name }));
          void queryClient.invalidateQueries({ queryKey: opQueryKey(nodes.list) });
          onRemoved();
        }}
      />
    </div>
  );
}

/**
 * A domain field with "*." inside it, in front of what you type (the
 * record is a wildcard), so the field keeps the form's left edge and width.
 * The setup wizard's wildcard step uses it too.
 */
export function WildcardInput({
  id,
  value,
  onChange,
  invalid = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}) {
  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-[13.5px] text-muted-foreground"
      >
        *.
      </span>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="de1.example.com"
        aria-invalid={invalid}
        className="pl-7 font-mono"
      />
    </div>
  );
}

/** "Add [*.domain A ip] at your DNS provider. Open Cloudflare DNS", with the record copyable: it goes into the provider as is. */
export function DnsRecordLine({ record }: { record: string }) {
  return (
    <p className="m-0 text-[12.5px] leading-[1.7] text-ink-strong">
      {t("nodes.addCard.dnsBefore")} <CopyCode code={record} aria-label={t("nodes.dnsRecord")} /> {t("nodes.dnsAtProvider")}{" "}
      <a href="https://dash.cloudflare.com" target="_blank" rel="noreferrer" className="font-medium whitespace-nowrap">
        {t("nodes.addCard.cloudflare")}
      </a>
    </p>
  );
}

/** "Geolocation by DB-IP": the link back DB-IP's license asks for wherever a location from its database shows. */
export function DbIpLink() {
  return (
    <a href="https://db-ip.com" target="_blank" rel="noreferrer" className="font-medium">
      {t("nodes.geolocationByDbIp")}
    </a>
  );
}

/** "From the server's IP address, Geolocation by DB-IP. Change it if it is wrong." under a detected location. */
function DetectedLocationHint() {
  return (
    <>
      {t("nodes.form.locationDetectedBefore")} <DbIpLink />
      {t("nodes.form.locationDetectedAfter")}
    </>
  );
}

function Field({
  id,
  label,
  hint,
  badge,
  note,
  children,
}: {
  id: string;
  label: MessageKey;
  /** Under the field, with the id `<id>-hint` for aria-describedby. */
  hint?: MessageKey;
  /** Next to the label, for example the Detected chip. */
  badge?: ReactNode;
  /** Under the field instead of the hint, with the id `<id>-note` for aria-describedby. */
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {badge ? (
        <div className="flex items-center gap-2">
          <Label htmlFor={id}>{t(label)}</Label>
          {badge}
        </div>
      ) : (
        <Label htmlFor={id}>{t(label)}</Label>
      )}
      {children}
      {note ? (
        <span id={`${id}-note`} className="text-xs text-muted-foreground">
          {note}
        </span>
      ) : (
        hint && (
          <span id={`${id}-hint`} className="text-xs text-muted-foreground">
            {t(hint)}
          </span>
        )
      )}
    </div>
  );
}

/**
 * Panel address: follow the panel's domain (the default) or stay on the
 * address the node connects to, saved on its own. Under it, who chose it
 * when that was not someone here: the node itself (`seylo set-panel`, a
 * join with the IP and pin) or an open alert about a re-signed certificate.
 */
function PanelAddressChoice({
  node,
  pending,
  onChange,
}: {
  node: NodeDetail;
  pending: boolean;
  onChange: (choice: "follow" | "stay") => void;
}) {
  const by = node.panelAddressChoiceBy;
  const why =
    by === "node"
      ? t("nodes.form.panelAddressBy.node", { command: `${slug} set-panel` })
      : by === "join"
        ? t("nodes.form.panelAddressBy.join")
        : by === "inspectedCertificate"
          ? t("nodes.form.panelAddressBy.inspectedCertificate")
          : null;
  return (
    <div className="flex flex-col gap-2 border-t border-divider pt-4">
      <div className="flex flex-col gap-0.5">
        <span id="node-panel-address" className="text-[13.5px] font-medium">
          {t("nodes.form.panelAddress")}
        </span>
        <span className="text-[12.5px] text-muted-foreground">{t("nodes.form.panelAddressHint")}</span>
      </div>
      <RadioGroup
        value={node.panelAddressChoice}
        onValueChange={(value) => {
          if (value !== node.panelAddressChoice) onChange(value as "follow" | "stay");
        }}
        aria-labelledby="node-panel-address"
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        <RadioCard
          value="follow"
          title={t("nodes.form.panelAddressFollow")}
          description={t("nodes.form.panelAddressFollowHint")}
          disabled={pending}
        />
        <RadioCard
          value="stay"
          title={t("nodes.form.panelAddressStay")}
          description={t("nodes.form.panelAddressStayHint")}
          disabled={pending}
        />
      </RadioGroup>
      {why && <p className="m-0 text-[12.5px] text-muted-foreground">{why}</p>}
    </div>
  );
}

function Toggle({
  title,
  hint,
  checked,
  disabled,
  onChange,
}: {
  title: MessageKey;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label htmlFor={`toggle-${title}`} className="flex items-start gap-3">
      <Switch id={`toggle-${title}`} checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
      <span className="flex flex-col gap-0.5">
        <span className="text-[13.5px] font-medium">{t(title)}</span>
        <span className="text-[12.5px] text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
