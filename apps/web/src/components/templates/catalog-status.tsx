// The Templates page's catalog line (templates.catalogStatus): where the
// templates come from (the official catalog downloaded from GitHub, or the
// copy bundled with the panel), the last failed check, a private catalog,
// how many are new or need a newer panel, and "Check for new templates" for
// people who hold templates.manage when there is something to download. A
// build without the catalog key (signingKey false, until the owner makes
// one) says plainly that the official catalog is not switched on yet. The
// owner changes the source in CatalogSourceDialog.

import { brand } from "@seylo/brand";
import { type OpOutput, templates } from "@seylo/ops";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input, Label } from "@seylo/ui/components/input";
import { Switch } from "@seylo/ui/components/switch";
import { IconRefresh, IconSettings } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { formatDate, formatRelative } from "../settings/format";
import { useSettingsMutation } from "../settings/mutation";

export type CatalogStatus = OpOutput<typeof templates.catalogStatus>;
type Source = NonNullable<CatalogStatus["source"]>;

const refreshes = [templates.catalogStatus, templates.list, templates.get];

/** The sentences of the status line, in order. Pure, so tests can check every variant. */
export function catalogSentences(status: CatalogStatus): string[] {
  const { official, extra } = status;
  const out: string[] = [];
  if (official.origin === "downloaded" && official.generatedAt && official.commit) {
    out.push(t("templates.catalog.official", { date: formatDate(official.generatedAt), commit: official.commit.slice(0, 7) }));
  } else if (official.origin === "bundled") {
    out.push(t("templates.catalog.bundled", { product: brand.displayName, version: official.bundledWith }));
  } else out.push(t("templates.catalog.none"));
  if (!official.enabled) out.push(t("templates.catalog.downloadsOff"));
  else if (!official.signingKey) {
    out.push(t("templates.catalog.notSwitchedOn"));
    // No download was tried: an error is about the copy that ships (one from a build with the key is old news).
    if (official.origin === null && official.lastError) out.push(official.lastError);
  } else if (official.lastError)
    out.push(
      official.lastTriedAt
        ? t("templates.catalog.lastError", { error: official.lastError, when: formatRelative(official.lastTriedAt) })
        : official.lastError,
    );
  if (status.newSlugs.length > 0) out.push(t("templates.catalog.newCount", { count: status.newSlugs.length }));
  if (extra) {
    out.push(t(extra.signed ? "templates.catalog.private" : "templates.catalog.privateUnsigned", { host: extra.host }));
    if (extra.lastError)
      out.push(
        extra.lastTriedAt
          ? t("templates.catalog.lastError", { error: extra.lastError, when: formatRelative(extra.lastTriedAt) })
          : extra.lastError,
      );
  }
  return out;
}

/** "Check for new templates" can download something: the official catalog (on, and this build has its key) or a private one. */
export function canCheckCatalog(status: CatalogStatus): boolean {
  return status.canRefresh && ((status.official.enabled && status.official.signingKey) || status.extra !== null);
}

export function CatalogStatusLine({ status }: { status: CatalogStatus }) {
  const [sourceOpen, setSourceOpen] = useState(false);
  const refresh = useSettingsMutation(templates.refreshCatalog, {
    invalidates: refreshes,
    success: (out) => {
      const error = out.official.enabled ? out.official.lastError : null;
      if (error) return t("templates.catalog.checkFailed", { error });
      return out.newSlugs.length > 0 ? t("templates.catalog.found", { count: out.newSlugs.length }) : t("templates.catalog.upToDate");
    },
  });
  const canCheck = canCheckCatalog(status);
  return (
    <div className="-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-muted-foreground" data-testid="catalog-status">
      <span className="min-w-0">
        {catalogSentences(status).join(" ")}
        {status.needNewerPanel > 0 && (
          <>
            {" "}
            <Link to="/settings/updates" className="text-link hover:text-link-hover">
              {t("templates.catalog.needNewer", { count: status.needNewerPanel, product: brand.displayName })}
            </Link>
          </>
        )}
        {status.skipped.length > 0 && (
          <span title={status.skipped.map((s) => `${s.slug}: ${s.reason}`).join("\n")}>
            {" "}
            {t("templates.catalog.skipped", { count: status.skipped.length })}
          </span>
        )}
      </span>
      {(canCheck || (status.canChangeSource && status.source)) && (
        <span className="flex gap-1.5">
          {canCheck && (
            <Button size="sm" onClick={() => refresh.mutate({})} disabled={refresh.isPending}>
              <IconRefresh size={14} stroke={1.8} className={refresh.isPending ? "animate-spin" : undefined} />
              {refresh.isPending ? t("templates.catalog.checking") : t("templates.catalog.check")}
            </Button>
          )}
          {status.canChangeSource && status.source && (
            <Button size="sm" onClick={() => setSourceOpen(true)}>
              <IconSettings size={14} stroke={1.8} />
              {t("templates.catalog.source")}
            </Button>
          )}
        </span>
      )}
      {status.source && (
        <CatalogSourceDialog
          open={sourceOpen}
          onOpenChange={setSourceOpen}
          source={status.source}
          signingKey={status.official.signingKey}
          version={status.official.bundledWith}
        />
      )}
    </div>
  );
}

function CatalogSourceDialog({
  open,
  onOpenChange,
  ...form
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: Source;
  signingKey: boolean;
  version: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[10%] max-w-[560px]">
        {/* Remounted on open, so the form starts from the saved setting. */}
        {open && <SourceForm {...form} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function SourceForm({ source, signingKey, version, onDone }: { source: Source; signingKey: boolean; version: string; onDone: () => void }) {
  const [official, setOfficial] = useState(source.official);
  const [withExtra, setWithExtra] = useState(source.extra !== null);
  const [url, setUrl] = useState(source.extra?.url ?? "");
  const [publicKey, setPublicKey] = useState(source.extra?.publicKey ?? "");
  const [allowUnsigned, setAllowUnsigned] = useState(source.extra?.allowUnsigned ?? false);
  const save = useSettingsMutation(templates.setCatalogSource, {
    invalidates: refreshes,
    success: t("templates.catalog.saved"),
    failure: false,
    onSuccess: onDone,
  });
  const unsigned = withExtra && publicKey.trim() === "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({
      official,
      extra: withExtra ? { url: url.trim(), publicKey: publicKey.trim() || null, allowUnsigned: unsigned && allowUnsigned } : null,
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <DialogTitle>{t("templates.catalog.source")}</DialogTitle>
        <DialogDescription>{t("templates.catalog.sourceDescription")}</DialogDescription>
      </div>
      <div className="flex items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Label htmlFor="catalog-official">{t("templates.catalog.officialTitle")}</Label>
          <span className="text-[12.5px] text-muted-foreground">
            {t("templates.catalog.officialDescription", { repo: `${brand.githubOrg}/${brand.templatesRepo}` })}
          </span>
          {!signingKey && (
            <span className="text-[12.5px] text-muted-foreground" data-testid="catalog-not-switched-on">
              {t("templates.catalog.notSwitchedOnDialog", { product: brand.displayName, version })}
            </span>
          )}
        </span>
        <Switch id="catalog-official" checked={official} onCheckedChange={setOfficial} />
      </div>
      <div className="flex flex-col gap-2.5 border-t border-divider pt-4">
        <div className="flex items-start gap-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <b className="text-[13px] font-medium">{t("templates.catalog.extraTitle")}</b>
            <span className="text-[12.5px] text-muted-foreground">{t("templates.catalog.extraDescription")}</span>
          </span>
          <Button size="sm" onClick={() => setWithExtra(!withExtra)}>
            {withExtra ? t("templates.catalog.removeExtra") : t("templates.catalog.addExtra")}
          </Button>
        </div>
        {withExtra && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="catalog-url">{t("templates.catalog.url")}</Label>
              <Input
                id="catalog-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://templates.example.com/catalog.json"
                required
                maxLength={2000}
                className="font-mono"
              />
              <span className="text-xs text-muted-foreground">{t("templates.catalog.urlHint")}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="catalog-key">{t("templates.catalog.publicKey")}</Label>
              <Input
                id="catalog-key"
                value={publicKey}
                onChange={(e) => setPublicKey(e.target.value)}
                maxLength={100}
                spellCheck={false}
                autoComplete="off"
                className="font-mono"
              />
              <span className="text-xs text-muted-foreground">{t("templates.catalog.publicKeyHint")}</span>
            </div>
            {unsigned && (
              <>
                <Label htmlFor="catalog-unsigned" className="flex cursor-pointer items-center gap-2 font-normal">
                  <Checkbox id="catalog-unsigned" checked={allowUnsigned} onCheckedChange={(value) => setAllowUnsigned(value === true)} />
                  {t("templates.catalog.allowUnsigned")}
                </Label>
                {allowUnsigned && <Alert tone="warning">{t("templates.catalog.unsignedWarning")}</Alert>}
              </>
            )}
          </>
        )}
      </div>
      {save.error && (
        <p role="alert" className="m-0 text-[13px] text-destructive">
          {errorMessage(save.error, t("common.unknownError"))}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={save.isPending || (unsigned && !allowUnsigned)}>
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}

/** Tags a card or the install dialog shows: New, and where a private catalog's template comes from. */
export function templateTags(template: { slug: string; catalog: string; unsigned: boolean }, newSlugs: ReadonlySet<string>) {
  const tags: { label: string; tone: "blue" | "amber" | "violet" }[] = [];
  if (newSlugs.has(template.slug)) tags.push({ label: t("templates.newTag"), tone: "blue" });
  if (template.catalog === "private")
    tags.push(
      template.unsigned
        ? { label: t("templates.privateUnsignedTag"), tone: "amber" }
        : { label: t("templates.privateTag"), tone: "violet" },
    );
  return tags;
}
