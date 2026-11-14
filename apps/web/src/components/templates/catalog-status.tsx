// The Templates page's catalog controls (templates.catalogStatus), on one
// line with the search: Catalog source for the owner, then the refresh
// button ("Check for new templates", templates.manage), then the search.
// Nothing else is said under the title while all is well: a problem (a
// failed check or a bad signature, a private catalog that failed, the
// official catalog switched off, a build without its key) is a dot on the
// refresh button whose tooltip says what is wrong and what to do; the
// catalog in use (where it comes from, when it was built, its commit, the
// last check) is in the Catalog source dialog. Templates that need a newer
// panel or could not be read get a short note, only when there are any.
// Opening the page asks the panel for a check in the background when the
// last one is old (checkDue, templates.checkCatalogIfDue); a newer catalog
// then reaches the list through the live invalidation. Until the Templates
// repo publishes its first catalog, GitHub answers 404 (notPublished):
// never a problem, the dialog and the check's toast say it plainly.

import { brand } from "@seylo/brand";
import { type OpOutput, templates } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input, Label } from "@seylo/ui/components/input";
import { KeyValue } from "@seylo/ui/components/key-value";
import { Switch } from "@seylo/ui/components/switch";
import { Tip } from "@seylo/ui/components/tooltip";
import { cn } from "@seylo/ui/lib/utils";
import { IconRefresh, IconSettings } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { formatDate, formatRelative } from "../settings/format";
import { invalidateOps, useSettingsMutation } from "../settings/mutation";

export type CatalogStatus = OpOutput<typeof templates.catalogStatus>;
type Source = NonNullable<CatalogStatus["source"]>;
type Info = CatalogStatus["official"] | NonNullable<CatalogStatus["extra"]>;

const refreshes = [templates.catalogStatus, templates.list, templates.get];
const officialRepo = `${brand.githubOrg}/${brand.templatesRepo}`;

/**
 * What is wrong with the catalogs and what to do about it, one sentence
 * group each: the refresh button's warning and the dialog's alert. Empty
 * when all is well (a catalog not published yet is not a problem). Pure,
 * so tests can check every variant.
 */
export function catalogProblems(status: CatalogStatus): string[] {
  const { official, extra } = status;
  const out: string[] = [];
  if (!official.enabled || !official.signingKey) {
    out.push(
      !official.enabled
        ? t(status.canChangeSource ? "templates.catalog.problems.offOwner" : "templates.catalog.problems.off")
        : t("templates.catalog.problems.noKey", { product: brand.displayName }),
    );
    // No download was tried: an error is about the copy that ships (one from before is old news).
    if (official.origin === null && official.lastError) out.push(official.lastError);
  } else if (official.lastError)
    out.push(
      official.lastTriedAt
        ? t("templates.catalog.problems.official", { error: official.lastError, when: formatRelative(official.lastTriedAt) })
        : official.lastError,
    );
  if (extra?.lastError)
    out.push(
      extra.lastTriedAt
        ? t("templates.catalog.problems.private", { host: extra.host, error: extra.lastError, when: formatRelative(extra.lastTriedAt) })
        : extra.lastError,
    );
  return out;
}

export interface InUseRow {
  label: string;
  value: string;
  mono?: boolean;
  href?: string;
}

/** When a catalog was last checked, or why it is not. */
function lastChecked(info: Info, official: CatalogStatus["official"] | null): string {
  if (official && !official.enabled) return t("templates.catalog.downloadsOff");
  if (official && !official.signingKey) return t("templates.catalog.noKey");
  return info.lastTriedAt ? formatRelative(info.lastTriedAt) : t("templates.catalog.notYet");
}

/**
 * The Catalog source dialog's "In use" rows: where the official catalog in
 * use comes from, when it was built, its commit and the last check; the
 * same for a private catalog; and whether the official one is published.
 */
export function catalogInUse(status: CatalogStatus): { official: InUseRow[]; extra: InUseRow[] | null; note: string | null } {
  const { official, extra } = status;
  const built = (info: Info) => (info.generatedAt ? formatDate(info.generatedAt) : "-");
  const commit = (info: Info, link: boolean): InUseRow => ({
    label: t("templates.catalog.commit"),
    value: info.commit ? info.commit.slice(0, 7) : "-",
    mono: info.commit !== null,
    ...(link && info.commit ? { href: `https://github.com/${officialRepo}/commit/${info.commit}` } : {}),
  });
  return {
    official: [
      {
        label: t("templates.catalog.inUse"),
        value:
          official.origin === "downloaded"
            ? t("templates.catalog.downloaded", { repo: officialRepo })
            : official.origin === "bundled"
              ? t("templates.catalog.bundled", { product: brand.displayName, version: official.bundledWith })
              : t("templates.catalog.none"),
      },
      { label: t("templates.catalog.built"), value: built(official) },
      commit(official, true),
      { label: t("templates.catalog.lastChecked"), value: lastChecked(official, official) },
    ],
    extra: extra && [
      {
        label: t("templates.catalog.extraTitle"),
        value: extra.signed ? extra.host : t("templates.catalog.privateUnsigned", { host: extra.host }),
      },
      { label: t("templates.catalog.built"), value: built(extra) },
      commit(extra, false),
      { label: t("templates.catalog.lastChecked"), value: lastChecked(extra, null) },
    ],
    // A 404 for catalog.json: nothing to download yet, which is not an error.
    note:
      official.enabled && official.signingKey && official.notPublished && !official.lastError
        ? t(official.origin === "downloaded" ? "templates.catalog.notPublishedNow" : "templates.catalog.notPublished")
        : null,
  };
}

/** "Check for new templates" can download something: the official catalog (on, and this build has its key) or a private one. */
export function canCheckCatalog(status: CatalogStatus): boolean {
  return status.canRefresh && ((status.official.enabled && status.official.signingKey) || status.extra !== null);
}

/** The toast after "Check for new templates": what it found. An official catalog not published yet is no failure. */
export function checkResult(out: CatalogStatus): string {
  const error = out.official.enabled ? out.official.lastError : null;
  if (error) return t("templates.catalog.checkFailed", { error });
  if (out.newSlugs.length > 0) return t("templates.catalog.found", { count: out.newSlugs.length });
  return out.official.notPublished ? t("templates.catalog.notPublished") : t("templates.catalog.upToDate");
}

/**
 * The toolbar on the title row: [Catalog source] (the owner) [refresh]
 * (templates.manage), then the search, 300px wide. On a phone the buttons
 * keep their row and the search takes the full width under them, like a
 * search box alone does there. Without a status (Docker Hub, or still
 * loading) it is the search alone.
 */
export function CatalogToolbar({ status, search }: { status: CatalogStatus | undefined; search: ReactNode }) {
  const [sourceOpen, setSourceOpen] = useState(false);
  const source = status?.canChangeSource ? status.source : null;
  return (
    <div data-testid="templates-toolbar" className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      {source && (
        <Button onClick={() => setSourceOpen(true)}>
          <IconSettings size={15} stroke={1.8} aria-hidden="true" />
          {t("templates.catalog.source")}
        </Button>
      )}
      {status?.canRefresh && <RefreshButton status={status} />}
      <div className="relative w-full sm:w-[300px]">{search}</div>
      {status && source && <CatalogSourceDialog open={sourceOpen} onOpenChange={setSourceOpen} status={status} source={source} />}
    </div>
  );
}

/**
 * "Check for new templates" as an icon: it spins while the panel checks and
 * ends with the toast checkResult picks. A problem puts a dot on it, and
 * the tooltip and the button's description say what is wrong. When
 * nothing can be downloaded it stays, dimmed, for that warning.
 */
function RefreshButton({ status }: { status: CatalogStatus }) {
  const refresh = useSettingsMutation(templates.refreshCatalog, { invalidates: refreshes, success: checkResult });
  const problems = catalogProblems(status);
  const canCheck = canCheckCatalog(status);
  const describedBy = useId();
  const label = t("templates.catalog.check");
  return (
    <Tip
      content={
        <span className="flex flex-col gap-1">
          <span className="font-medium">{label}</span>
          {problems.map((problem) => (
            <span key={problem}>{problem}</span>
          ))}
        </span>
      }
    >
      <Button
        aria-label={label}
        {...(problems.length > 0 ? { "aria-describedby": describedBy } : {})}
        aria-disabled={!canCheck || undefined}
        aria-busy={refresh.isPending || undefined}
        onClick={() => {
          if (canCheck && !refresh.isPending) refresh.mutate({});
        }}
        className={cn("relative size-[38px] px-0", !canCheck && "cursor-not-allowed")}
      >
        {/* Dimmed is the icon, not the button: the warning dot stays at full strength. */}
        <IconRefresh
          size={16}
          stroke={1.8}
          aria-hidden="true"
          className={cn(refresh.isPending && "animate-spin", !canCheck && "opacity-45")}
        />
        {problems.length > 0 && (
          <>
            <span
              aria-hidden="true"
              data-testid="catalog-problem"
              className="absolute -top-1 -right-1 size-3 rounded-full border-2 border-background bg-status-busy"
            />
            <span id={describedBy} className="sr-only">
              {problems.join(" ")}
            </span>
          </>
        )}
      </Button>
    </Tip>
  );
}

/** Templates left out (a newer panel needed, or unreadable): a short note under the title, only when there are any. */
export function CatalogNotes({ status }: { status: CatalogStatus }) {
  if (status.needNewerPanel === 0 && status.skipped.length === 0) return null;
  return (
    <p data-testid="catalog-notes" className="-mt-2 mb-0 flex flex-wrap gap-x-1 text-[12.5px] text-muted-foreground">
      {status.needNewerPanel > 0 && (
        <Link to="/settings/updates" className="text-link hover:text-link-hover">
          {t("templates.catalog.needNewer", { count: status.needNewerPanel, product: brand.displayName })}
        </Link>
      )}
      {status.skipped.length > 0 && (
        <span title={status.skipped.map((s) => `${s.slug}: ${s.reason}`).join("\n")}>
          {t("templates.catalog.skipped", { count: status.skipped.length })}
        </span>
      )}
    </p>
  );
}

/**
 * Opening the Templates page asks the panel for a check in the background
 * when the status says one is due: once per visit, never per keystroke or
 * render. The panel refuses a second while one runs; the status is read
 * again right away, so it says no check is due while that one runs.
 */
export function useCatalogCheckOnOpen(status: CatalogStatus | undefined): void {
  const check = useOpMutation(templates.checkCatalogIfDue, { onSuccess: () => invalidateOps([templates.catalogStatus]) });
  const asked = useRef(false);
  const due = status?.checkDue === true;
  // biome-ignore lint/correctness/useExhaustiveDependencies: asks once, when the status first says a check is due
  useEffect(() => {
    if (!due || asked.current) return;
    asked.current = true;
    check.mutate({});
  }, [due]);
}

function CatalogSourceDialog({
  open,
  onOpenChange,
  status,
  source,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: CatalogStatus;
  source: Source;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[10%] max-w-[560px]">
        {/* Remounted on open, so the form starts from the saved setting. */}
        {open && <SourceForm status={status} source={source} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

/** Rows as the dialog shows them: a label above each value, four to a line from sm up. */
function InUseRows({ rows, testId }: { rows: InUseRow[]; testId: string }) {
  return (
    <div data-testid={testId}>
      <KeyValue
        layout="grid"
        className="grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-[1.6fr_1fr_1fr_1fr]"
        items={rows.map((row) => ({
          key: row.label,
          label: row.label,
          mono: row.mono,
          value: row.href ? (
            <a href={row.href} target="_blank" rel="noreferrer" className="text-link hover:text-link-hover">
              {row.value}
            </a>
          ) : (
            row.value
          ),
        }))}
      />
    </div>
  );
}

/** What is in use now and what is wrong with it, above the form. */
function InUse({ status }: { status: CatalogStatus }) {
  const inUse = catalogInUse(status);
  const problems = catalogProblems(status);
  return (
    <div className="flex flex-col gap-3">
      <InUseRows rows={inUse.official} testId="catalog-in-use" />
      {inUse.note && <p className="m-0 text-[12.5px] text-muted-foreground">{inUse.note}</p>}
      {inUse.extra && <InUseRows rows={inUse.extra} testId="catalog-in-use-private" />}
      {problems.length > 0 && (
        <Alert tone="warning" data-testid="catalog-problems">
          {problems.map((problem) => (
            <p key={problem} className="m-0">
              {problem}
            </p>
          ))}
        </Alert>
      )}
    </div>
  );
}

function SourceForm({ status, source, onDone }: { status: CatalogStatus; source: Source; onDone: () => void }) {
  const { signingKey, bundledWith: version } = status.official;
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
      <InUse status={status} />
      <div className="flex flex-col gap-2.5 border-t border-divider pt-4">
        <div className="flex items-start gap-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <Label htmlFor="catalog-official">{t("templates.catalog.officialTitle")}</Label>
            <span className="text-[12.5px] text-muted-foreground">
              {t("templates.catalog.officialDescription", { repo: officialRepo })}
            </span>
          </span>
          <Switch id="catalog-official" checked={official} onCheckedChange={setOfficial} />
        </div>
        {!signingKey && (
          <p className="m-0 text-[12.5px] text-muted-foreground" data-testid="catalog-no-key">
            {t("templates.catalog.noKeyDialog", { product: brand.displayName, version })}
          </p>
        )}
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
