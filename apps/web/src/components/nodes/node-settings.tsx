// Node settings in the node sheet. Each group saves on its own op:
// rename, tags, the general settings (location, wildcard domain, parallel
// builds, log retention), the can-build switch and games-first CPU (only
// when Wings is detected), and removing the node.

import { nodes } from "@seylo/ops";
import { opQueryKey, useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { Input, Label } from "@seylo/ui/components/input";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { type FormEvent, type ReactNode, useState } from "react";
import { type MessageKey, t } from "../../i18n/t";
import { errorMessage, queryClient } from "../../lib/api";
import type { NodeDetail } from "../../lib/types";

const mib = 1024 * 1024;

function refresh(nodeId: string) {
  void queryClient.invalidateQueries({ queryKey: opQueryKey(nodes.get, { nodeId }) });
  void queryClient.invalidateQueries({ queryKey: opQueryKey(nodes.list) });
}

export function NodeSettingsForm({ node, onRemoved }: { node: NodeDetail; onRemoved: () => void }) {
  const [name, setName] = useState(node.name);
  const [location, setLocation] = useState(node.location ?? "");
  const [publicAddress, setPublicAddress] = useState(node.publicAddress ?? "");
  const [tags, setTags] = useState(node.tags.join(", "));
  const [wildcard, setWildcard] = useState(node.wildcardDomain ?? "");
  const [parallel, setParallel] = useState(String(node.maxParallelBuilds));
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
        maxParallelBuilds: Number(parallel),
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
          <Field id="node-location" label="nodes.form.location">
            <Input
              id="node-location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              maxLength={80}
              placeholder="Falkenstein, Germany"
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
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] text-muted-foreground">*.</span>
            <Input
              id="node-wildcard"
              value={wildcard}
              onChange={(e) => setWildcard(e.target.value)}
              placeholder="de1.example.com"
              className="font-mono"
            />
          </div>
        </Field>
        {wildcard.trim() && dnsIp && (
          <p className="m-0 text-[12.5px] leading-relaxed text-ink-strong">
            {t("nodes.addCard.dnsBefore")}{" "}
            <span className="rounded-chip bg-muted px-[7px] py-0.5 font-mono text-xs text-foreground">
              *.{wildcard.trim().replace(/^\*\./, "")} A {dnsIp}
            </span>{" "}
            <a href="https://dash.cloudflare.com" target="_blank" rel="noreferrer" className="font-medium">
              {t("nodes.addCard.cloudflare")}
            </a>
          </p>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field id="node-parallel" label="nodes.form.parallelBuilds">
            <Input id="node-parallel" type="number" min={1} max={16} value={parallel} onChange={(e) => setParallel(e.target.value)} />
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
        description={t("nodes.form.removeHint")}
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

function Field({ id, label, hint, children }: { id: string; label: MessageKey; hint?: MessageKey; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{t(label)}</Label>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{t(hint)}</span>}
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
