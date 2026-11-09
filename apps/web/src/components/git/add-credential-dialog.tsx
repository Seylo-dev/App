// The Add credential dialog: an HTTPS access token, or an SSH key the panel
// generates (git.generateSshKey: the next step shows its public key to add
// as a read-only deploy key) or one pasted in. SSH hosts other than GitHub
// need their host keys: "Read host keys" asks git.scanHostKeys and shows the
// fingerprints to compare, and known_hosts lines can be pasted instead. The
// new credential goes straight into the git.listCredentials cache, so the
// form that opened the dialog can select it at once.

import { git, type OpOutput } from "@seylo/ops";
import { opQueryKey, useOpClient, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { CopyField } from "@seylo/ui/components/copy-field";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input } from "@seylo/ui/components/input";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { Textarea } from "@seylo/ui/components/textarea";
import { toast } from "@seylo/ui/components/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { Field } from "../service/field";
import { MutationError } from "../service/op-state";
import {
  type CredentialKind,
  credentialHost,
  isSshUrl,
  kindForUrl,
  looksLikePrivateKey,
  needsKnownHosts,
  providerOf,
  repoLabel,
  validHost,
} from "./credential-host";

export type GitCredential = OpOutput<typeof git.listCredentials>["items"][number];
type KeySource = "generate" | "paste";

/**
 * Adds a git credential. `url` (the repository URL being set up, if any)
 * fills the host, the name and the kind; onCreated gets the new credential.
 */
export function AddCredentialDialog({
  open,
  onOpenChange,
  url = "",
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url?: string;
  onCreated?: (credential: GitCredential) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[8%] max-h-[84dvh] max-w-[520px] overflow-y-auto">
        {/* Content unmounts when the dialog closes, so every opening starts from the URL again. */}
        <AddCredentialForm url={url} onClose={() => onOpenChange(false)} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}

/** Puts a new credential into the cached list (sorted by name, as the panel lists them) and refetches it. */
function useAddToList() {
  const queryClient = useQueryClient();
  return (credential: GitCredential) => {
    const key = opQueryKey(git.listCredentials, {});
    queryClient.setQueryData<OpOutput<typeof git.listCredentials>>(key, (old) =>
      old
        ? { items: [...old.items.filter((c) => c.id !== credential.id), credential].sort((a, b) => a.name.localeCompare(b.name)) }
        : { items: [credential] },
    );
    void queryClient.invalidateQueries({ queryKey: opQueryKey(git.listCredentials) });
  };
}

function AddCredentialForm({ url, onClose, onCreated }: { url: string; onClose: () => void; onCreated?: (c: GitCredential) => void }) {
  const [kind, setKind] = useState<CredentialKind>(() => kindForUrl(url));
  const [name, setName] = useState(() => repoLabel(url));
  const [host, setHost] = useState(() => credentialHost(url) ?? "");
  const [username, setUsername] = useState("git");
  const [token, setToken] = useState("");
  const [keySource, setKeySource] = useState<KeySource>("generate");
  const [privateKey, setPrivateKey] = useState("");
  const [knownHosts, setKnownHosts] = useState("");
  const [fingerprints, setFingerprints] = useState<string[]>([]);
  const [pasteHostKeys, setPasteHostKeys] = useState(false);
  // The generated key, shown in the second step.
  const [generated, setGenerated] = useState<GitCredential | null>(null);

  const client = useOpClient();
  const addToList = useAddToList();
  const added = (credential: GitCredential) => {
    addToList(credential);
    toast.success(t("gitCredentials.add.added", { name: credential.name }));
    onCreated?.(credential);
  };
  const create = useOpMutation(git.createCredential, {
    onSuccess: (credential) => {
      added(credential);
      onClose();
    },
  });
  const generate = useOpMutation(git.generateSshKey, {
    onSuccess: (credential) => {
      added(credential);
      setGenerated(credential);
    },
  });
  const scan = useMutation({
    mutationFn: (forHost: string) => client.call(git.scanHostKeys, { host: forHost }),
    onSuccess: (keys) => {
      setKnownHosts(keys.lines.join("\n"));
      setFingerprints(keys.fingerprints);
    },
  });

  if (generated) return <DeployKeyStep credential={generated} onDone={onClose} />;

  const cleanHost = host.trim().toLowerCase();
  const provider = providerOf(cleanHost);
  const hostOk = validHost(cleanHost);
  const ssh = kind === "ssh_key";
  const keysNeeded = ssh && hostOk && needsKnownHosts(cleanHost);
  const busy = create.isPending || generate.isPending;
  const urlMismatch = url !== "" && (ssh ? !isSshUrl(url) : isSshUrl(url));
  const ready =
    name.trim() !== "" &&
    hostOk &&
    (ssh
      ? (!keysNeeded || knownHosts.trim() !== "") && (keySource === "generate" || looksLikePrivateKey(privateKey))
      : token.trim() !== "");

  const changeHost = (next: string) => {
    setHost(next);
    // Keys read for another host do not vouch for this one.
    setKnownHosts("");
    setFingerprints([]);
    scan.reset();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // React events bubble out of the dialog's portal: a form around the opener must not submit too.
    event.stopPropagation();
    if (!ready || busy) return;
    const base = { name: name.trim(), host: cleanHost };
    const lines = keysNeeded ? knownHosts.trim() : undefined;
    if (!ssh) create.mutate({ ...base, kind: "token", username: username.trim() || undefined, token: token.trim() });
    else if (keySource === "paste") create.mutate({ ...base, kind: "ssh_key", privateKey: privateKey.trim(), knownHosts: lines });
    else generate.mutate({ ...base, knownHosts: lines });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <DialogTitle>{t("gitCredentials.add.title")}</DialogTitle>
        <DialogDescription>{t("gitCredentials.add.description")}</DialogDescription>
      </div>
      <Segmented
        value={kind}
        onValueChange={(v) => setKind(v as CredentialKind)}
        aria-label={t("gitCredentials.add.kind")}
        className="self-start"
      >
        <SegmentedItem value="token">{t("gitCredentials.kinds.token")}</SegmentedItem>
        <SegmentedItem value="ssh_key">{t("gitCredentials.kinds.ssh_key")}</SegmentedItem>
      </Segmented>
      {urlMismatch && (
        <Callout tone="neutral" className="text-[12.5px]">
          {t(ssh ? "gitCredentials.add.httpsUrlForKey" : "gitCredentials.add.sshUrlForToken")}
        </Callout>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("gitCredentials.add.name")} htmlFor="credential-name">
          <Input
            id="credential-name"
            value={name}
            maxLength={60}
            placeholder={t("gitCredentials.add.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label={t("gitCredentials.add.host")} htmlFor="credential-host">
          <Input
            id="credential-host"
            className="font-mono"
            value={host}
            placeholder="git.example.com"
            aria-invalid={host.trim() !== "" && !hostOk}
            onChange={(e) => changeHost(e.target.value)}
          />
        </Field>
      </div>

      {!ssh && (
        <>
          <Field label={t("gitCredentials.add.username")} htmlFor="credential-username" hint={t("gitCredentials.add.usernameHint")}>
            <Input
              id="credential-username"
              className="font-mono"
              value={username}
              maxLength={100}
              autoComplete="off"
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label={t("gitCredentials.add.token")} htmlFor="credential-token" hint={t(`gitCredentials.add.tokenHint.${provider}`)}>
            <Input
              id="credential-token"
              type="password"
              className="font-mono"
              value={token}
              maxLength={1000}
              autoComplete="off"
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
        </>
      )}

      {ssh && (
        <>
          <Field label={t("gitCredentials.add.keySource")}>
            <Segmented
              value={keySource}
              onValueChange={(v) => setKeySource(v as KeySource)}
              aria-label={t("gitCredentials.add.keySource")}
              className="self-start"
            >
              <SegmentedItem value="generate">{t("gitCredentials.add.keySources.generate")}</SegmentedItem>
              <SegmentedItem value="paste">{t("gitCredentials.add.keySources.paste")}</SegmentedItem>
            </Segmented>
          </Field>
          {keySource === "generate" ? (
            <p className="m-0 text-[12.5px] leading-normal text-muted-foreground">{t("gitCredentials.add.generateHint")}</p>
          ) : (
            <Field label={t("gitCredentials.add.privateKey")} htmlFor="credential-key" hint={t("gitCredentials.add.privateKeyHint")}>
              <Textarea
                id="credential-key"
                mono
                rows={4}
                value={privateKey}
                spellCheck={false}
                autoComplete="off"
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                aria-invalid={privateKey.trim() !== "" && !looksLikePrivateKey(privateKey)}
                onChange={(e) => setPrivateKey(e.target.value)}
              />
            </Field>
          )}
          {hostOk && !keysNeeded && <p className="m-0 text-[12.5px] text-muted-foreground">{t("gitCredentials.add.githubHostKeys")}</p>}
          {keysNeeded && (
            <HostKeys
              host={cleanHost}
              fingerprints={fingerprints}
              scanning={scan.isPending}
              scanError={scan.error}
              onScan={() => scan.mutate(cleanHost)}
              paste={pasteHostKeys}
              onPaste={() => setPasteHostKeys(true)}
              knownHosts={knownHosts}
              onKnownHostsChange={(v) => {
                setKnownHosts(v);
                setFingerprints([]);
              }}
            />
          )}
        </>
      )}

      <MutationError error={create.error ?? generate.error} />
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!ready || busy}>
          {ssh && keySource === "generate"
            ? generate.isPending
              ? t("gitCredentials.add.generating")
              : t("gitCredentials.add.generate")
            : create.isPending
              ? t("gitCredentials.add.saving")
              : t("gitCredentials.add.save")}
        </Button>
      </div>
    </form>
  );
}

/** Known hosts for an SSH host the panel does not know: read them (git.scanHostKeys) or paste them. */
function HostKeys({
  host,
  fingerprints,
  scanning,
  scanError,
  onScan,
  paste,
  onPaste,
  knownHosts,
  onKnownHostsChange,
}: {
  host: string;
  fingerprints: string[];
  scanning: boolean;
  scanError: unknown;
  onScan: () => void;
  paste: boolean;
  onPaste: () => void;
  knownHosts: string;
  onKnownHostsChange: (value: string) => void;
}) {
  return (
    <Field
      label={t("gitCredentials.add.hostKeys")}
      hint={fingerprints.length > 0 ? t("gitCredentials.add.hostKeysHint", { host }) : t("gitCredentials.add.hostKeysNeeded", { host })}
    >
      {fingerprints.length > 0 && (
        <ul
          aria-label={t("gitCredentials.add.hostKeys")}
          className="m-0 flex list-none flex-col gap-1 rounded-control bg-muted px-3 py-2.5"
        >
          {fingerprints.map((f) => (
            <li key={f} className="font-mono text-[12px] break-all">
              {f}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onScan} disabled={scanning}>
          {scanning ? t("gitCredentials.add.scanning") : t("gitCredentials.add.scan")}
        </Button>
        {!paste && (
          <Button size="sm" variant="ghost" onClick={onPaste}>
            {t("gitCredentials.add.pasteHostKeys")}
          </Button>
        )}
      </div>
      {scanError ? (
        <p role="alert" className="m-0 text-[12.5px] text-chip-red-fg">
          {errorMessage(scanError, t("common.unknownError"))}
        </p>
      ) : null}
      {paste && (
        <Textarea
          aria-label={t("gitCredentials.add.knownHosts")}
          mono
          rows={3}
          value={knownHosts}
          spellCheck={false}
          placeholder={`${host} ssh-ed25519 AAAA…`}
          onChange={(e) => onKnownHostsChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/** After git.generateSshKey: the public key to add as a read-only deploy key, and where. */
function DeployKeyStep({ credential, onDone }: { credential: GitCredential; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <DialogTitle>{t("gitCredentials.add.keyTitle")}</DialogTitle>
        <DialogDescription>{t("gitCredentials.add.keyBody")}</DialogDescription>
      </div>
      <Field label={t("gitCredentials.add.publicKey")} hint={t(`gitCredentials.add.deployKeyWhere.${providerOf(credential.host)}`)}>
        <CopyField value={credential.publicKey ?? ""} aria-label={t("gitCredentials.add.publicKey")} />
      </Field>
      {credential.fingerprint && (
        <p className="m-0 text-[12.5px] text-muted-foreground">
          {t("gitCredentials.add.fingerprint")}: <span className="font-mono break-all">{credential.fingerprint}</span>
        </p>
      )}
      <div className="flex justify-end">
        <Button variant="primary" onClick={onDone} autoFocus>
          {t("gitCredentials.add.done")}
        </Button>
      </div>
    </div>
  );
}
