// Settings > Appearance (Appearance board): theme preset with previews,
// color mode and accent; branding (name, logos, favicon, sign-in message,
// powered-by line); custom CSS in Monaco (owner only) with a short guide
// and an example to insert. Every preset has a light and a dark half; the
// color mode picks one for all of them, and the preview tiles show the
// half it picks. Edits preview live on this page; Save stores them for
// everyone, and leaving without saving puts the saved look back.

import { displayName } from "@seylo/brand";
import { auth, type OpOutput, settings } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Input } from "@seylo/ui/components/input";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";
import { BrandAssetTile } from "../../../components/settings/appearance/brand-asset";
import { CssEditor, type CssEditorHandle } from "../../../components/settings/appearance/css-editor";
import { accentChoices, customCssExample, normalizeHex, presetSwatches } from "../../../components/settings/appearance/presets";
import { invalidateOps } from "../../../components/settings/mutation";
import { OpErrorCallout, toastError } from "../../../components/settings/op-state";
import { t } from "../../../i18n/t";
import { opClient } from "../../../lib/api";
import { paintAppearance, prefersDark, refreshBoot as refreshSharedBoot } from "../../../lib/theme";

export const Route = createFileRoute("/_app/settings/appearance")({
  component: AppearancePage,
});

type Appearance = OpOutput<typeof settings.appearance>;
type Branding = OpOutput<typeof settings.branding>;

function AppearancePage() {
  const appearance = useOp(settings.appearance, {});
  const branding = useOp(settings.branding, {});
  const me = useOp(auth.whoami, {});
  const error = appearance.error ?? branding.error;

  if (error) {
    return (
      <Shell>
        <OpErrorCallout error={error} onRetry={() => void Promise.all([appearance.refetch(), branding.refetch()])} />
      </Shell>
    );
  }
  if (!appearance.data || !branding.data || !me.data) {
    return (
      <Shell>
        <AppearanceSkeleton />
      </Shell>
    );
  }
  return <AppearanceEditor saved={appearance.data} savedBranding={branding.data} isOwner={me.data.viewer.role === "owner"} />;
}

/** The theme card, branding and custom CSS while the saved look loads; titles are real, values are placeholders. */
function AppearanceSkeleton() {
  return (
    <LoadingRegion label={t("common.loading")} className="flex flex-col gap-[18px]">
      <Card className="gap-4 px-[22px] py-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="m-0 text-[15px] font-semibold">{t("settingsAppearance.theme")}</h2>
          <Skeleton className="ml-auto h-8 w-[184px]" />
        </div>
        <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-5">
          {settings.themePresets.map((preset) => (
            <Skeleton key={preset} className="h-[169px] rounded-card" />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2.5 border-t border-divider pt-3.5 text-[13px]">
          <span className="mr-0.5 font-medium text-ink-strong">{t("settingsAppearance.accent")}</span>
          <span className="flex flex-nowrap items-center gap-2">
            <Skeleton className="h-6 w-[88px] rounded-full" />
            {accentChoices.map((color) => (
              <Skeleton key={color} className="size-6 rounded-full" />
            ))}
          </span>
          <Skeleton className="ml-1 h-[38px] w-[104px] max-sm:ml-0" />
        </div>
      </Card>
      <div className="flex flex-wrap items-start gap-4">
        <Card className="min-w-0 flex-[1_1_340px] gap-3.5 px-[22px] py-5">
          <h2 className="m-0 text-[15px] font-semibold">{t("settingsAppearance.branding.title")}</h2>
          <div className="flex flex-col gap-1.5">
            <SkeletonText className="w-20 text-[12.5px]" />
            <Skeleton className="h-[38px]" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[72px]" />
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <SkeletonText className="w-32 text-[12.5px]" />
            <Skeleton className="h-[38px]" />
          </div>
          <SkeletonText className="w-56 text-[13px]" />
        </Card>
        <div className="flex h-[371px] min-w-0 flex-[1_1_340px] flex-col overflow-hidden rounded-card bg-terminal shadow-card">
          <div className="flex flex-wrap items-center gap-2.5 bg-terminal-bar px-[18px] py-3.5">
            <h2 className="m-0 text-[15px] font-semibold text-terminal-foreground">{t("settingsAppearance.css.title")}</h2>
            <span className="text-xs text-terminal-muted">{t("settingsAppearance.css.hint")}</span>
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}

function Shell({ actions, children }: { actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-[18px]">
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="m-0 text-2xl font-semibold tracking-[-0.02em]">{t("settingsAppearance.title")}</h1>
          <p className="m-0 text-[13.5px] text-muted-foreground">{t("settingsAppearance.subtitle")}</p>
        </div>
        {actions && <div className="ml-auto">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

function AppearanceEditor({ saved, savedBranding, isOwner }: { saved: Appearance; savedBranding: Branding; isOwner: boolean }) {
  const [preset, setPreset] = useState(saved.preset);
  const [colorMode, setColorMode] = useState(saved.colorMode);
  const [accent, setAccent] = useState<string | null>(saved.accent);
  const [accentText, setAccentText] = useState(saved.accent ?? "");
  const [customCss, setCustomCss] = useState(saved.customCss);
  const [name, setName] = useState(savedBranding.name);
  const [loginMessage, setLoginMessage] = useState(savedBranding.loginMessage);
  const [hidePoweredBy, setHidePoweredBy] = useState(savedBranding.hidePoweredBy);
  const [saving, setSaving] = useState(false);
  const cssEditor = useRef<CssEditorHandle>(null);

  // The look to restore when leaving without saving.
  const savedRef = useRef(saved);
  savedRef.current = saved;
  useEffect(() => () => paintAppearance(savedRef.current), []);

  // Live preview: everything but custom CSS at once, custom CSS after a short pause in typing.
  const [previewCss, setPreviewCss] = useState(customCss);
  useEffect(() => {
    const timer = setTimeout(() => setPreviewCss(customCss), 300);
    return () => clearTimeout(timer);
  }, [customCss]);
  // The half the tiles show: the one the draft color mode paints right now.
  const [deviceDark, setDeviceDark] = useState(prefersDark);
  useEffect(() => {
    const draft = { preset, colorMode, accent, customCss: previewCss };
    paintAppearance(draft);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => {
      setDeviceDark(media.matches);
      if (colorMode === "system") paintAppearance(draft);
    };
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, [preset, colorMode, accent, previewCss]);
  const half = settings.resolveColorScheme(colorMode, deviceDark);

  const appearancePatch = {
    ...(preset !== saved.preset ? { preset } : {}),
    ...(colorMode !== saved.colorMode ? { colorMode } : {}),
    ...(accent !== saved.accent ? { accent } : {}),
    ...(isOwner && customCss !== saved.customCss ? { customCss } : {}),
  };
  const brandingPatch = {
    ...(name.trim() !== savedBranding.name ? { name: name.trim() } : {}),
    ...(loginMessage !== savedBranding.loginMessage ? { loginMessage } : {}),
    ...(hidePoweredBy !== savedBranding.hidePoweredBy ? { hidePoweredBy } : {}),
  };
  const dirty = Object.keys(appearancePatch).length > 0 || Object.keys(brandingPatch).length > 0;
  const accentInvalid = accentText.trim() !== "" && normalizeHex(accentText) === null;

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (Object.keys(appearancePatch).length > 0) await opClient.call(settings.updateAppearance, appearancePatch);
      if (Object.keys(brandingPatch).length > 0) await opClient.call(settings.updateBranding, brandingPatch);
      await refreshBoot();
      await invalidateOps([settings.appearance, settings.branding, settings.general]);
      toast.success(t("settings.saved"));
    } catch (error) {
      toastError(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell
      actions={
        <Button variant="primary" disabled={!dirty || saving || accentInvalid || !name.trim()} onClick={() => void save()}>
          {saving ? t("settings.saving") : t("settings.save")}
        </Button>
      }
    >
      <Card className="gap-4 px-[22px] py-5" aria-label={t("settingsAppearance.theme")}>
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="m-0 text-[15px] font-semibold">{t("settingsAppearance.theme")}</h2>
          <Segmented
            value={colorMode}
            onValueChange={(v) => setColorMode(v as Appearance["colorMode"])}
            aria-label={t("settingsAppearance.colorMode")}
            className="ml-auto"
          >
            {(["light", "dark", "system"] as const).map((mode) => (
              <SegmentedItem key={mode} value={mode} className="px-3">
                {t(`settingsAppearance.modes.${mode}`)}
              </SegmentedItem>
            ))}
          </Segmented>
        </div>
        <div role="radiogroup" aria-label={t("settingsAppearance.preset")} className="grid grid-cols-2 gap-3.5 lg:grid-cols-5">
          {settings.themePresets.map((p) => (
            <PresetTile key={p} preset={p} half={half} selected={preset === p} onSelect={() => setPreset(p)} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2.5 border-t border-divider pt-3.5 text-[13px]">
          <span className="mr-0.5 font-medium text-ink-strong">{t("settingsAppearance.accent")}</span>
          <span className="flex flex-nowrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setAccent(null);
                setAccentText("");
              }}
              className={cn(
                "h-6 cursor-pointer rounded-full border-0 bg-muted px-2.5 text-xs text-ink-strong transition-shadow duration-200",
                accent === null && "shadow-[0_0_0_2px_var(--card),0_0_0_4px_var(--primary)]",
              )}
            >
              {t("settingsAppearance.presetAccent")}
            </button>
            {accentChoices.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={color}
                aria-pressed={accent === color}
                onClick={() => {
                  setAccent(color);
                  setAccentText(color);
                }}
                // The swatch shows the color it picks, so it is painted with that value. A faint inner edge
                // keeps a swatch as dark (or as light) as the card from disappearing into it.
                style={{
                  background: color,
                  boxShadow:
                    accent === color
                      ? `inset 0 0 0 1px var(--swatch-edge), 0 0 0 2px var(--card), 0 0 0 4px ${color}`
                      : "inset 0 0 0 1px var(--swatch-edge)",
                }}
                className="size-6 cursor-pointer rounded-full border-0 p-0 transition-shadow duration-200 [--swatch-edge:rgb(15_23_42/0.12)] dark:[--swatch-edge:rgb(255_255_255/0.18)]"
              />
            ))}
          </span>
          <Input
            aria-label={t("settingsAppearance.customAccent")}
            aria-invalid={accentInvalid || undefined}
            value={accentText}
            placeholder="#2563EB"
            onChange={(e) => {
              setAccentText(e.target.value);
              const hex = normalizeHex(e.target.value);
              if (hex) setAccent(hex);
              else if (e.target.value.trim() === "") setAccent(null);
            }}
            // The panel's 38px field height; on a phone it takes its own line under the swatches.
            className="w-[104px] font-mono text-[12.5px] max-sm:w-full sm:ml-1"
          />
        </div>
      </Card>

      <div className="flex flex-wrap items-start gap-4">
        <Card className="min-w-0 flex-[1_1_340px] gap-3.5 px-[22px] py-5" aria-label={t("settingsAppearance.branding.title")}>
          <h2 className="m-0 text-[15px] font-semibold">{t("settingsAppearance.branding.title")}</h2>
          <label htmlFor="brand-name" className="flex flex-col gap-1.5 text-[12.5px] font-medium text-ink-strong">
            {t("settingsAppearance.branding.name")}
            <Input id="brand-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} className="font-normal" />
          </label>
          <div className="grid grid-cols-3 gap-2">
            {settings.brandAssetKinds.map((kind) => (
              <BrandAssetTile key={kind} kind={kind} url={savedBranding[kind]} disabled={false} onChanged={() => void refreshBoot()} />
            ))}
          </div>
          <label htmlFor="brand-login" className="flex flex-col gap-1.5 text-[12.5px] font-medium text-ink-strong">
            {t("settingsAppearance.branding.loginMessage")}
            <Input
              id="brand-login"
              value={loginMessage}
              maxLength={280}
              // The sign-in page has no message of its own: say what shows without one.
              placeholder={t("settingsAppearance.branding.loginMessagePlaceholder", { name: name.trim() || savedBranding.name })}
              onChange={(e) => setLoginMessage(e.target.value)}
              className="font-normal"
            />
          </label>
          <label htmlFor="brand-powered" className="flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-strong">
            <Checkbox id="brand-powered" checked={hidePoweredBy} onCheckedChange={(v) => setHidePoweredBy(v === true)} />
            {t("settingsAppearance.branding.hidePoweredBy", { product: displayName })}
          </label>
        </Card>

        <section
          aria-label={t("settingsAppearance.css.title")}
          className="flex min-w-0 flex-[1_1_340px] flex-col overflow-hidden rounded-card bg-terminal shadow-card"
        >
          <div className="flex flex-wrap items-center gap-2.5 bg-terminal-bar px-[18px] py-3.5">
            <h2 className="m-0 text-[15px] font-semibold text-terminal-foreground">{t("settingsAppearance.css.title")}</h2>
            <span className="text-xs text-terminal-muted">{t("settingsAppearance.css.hint")}</span>
            {isOwner && (
              <button
                type="button"
                onClick={() => cssEditor.current?.insert(customCssExample)}
                className="ml-auto h-7 cursor-pointer rounded-control border-0 bg-terminal-field px-2.5 text-xs font-medium text-terminal-foreground transition-interactive hover:brightness-125"
              >
                {t("settingsAppearance.css.insertExample")}
              </button>
            )}
          </div>
          <CssEditor
            ref={cssEditor}
            value={customCss}
            onChange={setCustomCss}
            readOnly={!isOwner}
            aria-label={t("settingsAppearance.css.title")}
          />
          {!isOwner && <p className="m-0 px-[18px] pb-3 text-xs text-terminal-muted">{t("settingsAppearance.css.ownerOnly")}</p>}
          <CssGuide />
        </section>
      </div>
    </Shell>
  );
}

function PresetTile({
  preset,
  half,
  selected,
  onSelect,
}: {
  preset: settings.ThemePreset;
  half: "light" | "dark";
  selected: boolean;
  onSelect: () => void;
}) {
  const s = presetSwatches[preset][half];
  const soft = s.edge === "shadow";
  const sideShadow = soft ? `1px 0 0 ${s.line}, 3px 0 10px rgba(15,23,42,0.04)` : s.edge === "line" ? `1px 0 0 ${s.line}` : "none";
  const cardShadow = soft
    ? "0 1px 2px rgba(15,23,42,0.05), 0 3px 8px rgba(15,23,42,0.06)"
    : s.edge === "line"
      ? `inset 0 0 0 1px ${s.line}`
      : "none";
  return (
    // biome-ignore lint/a11y/useSemanticElements: a picture card acting as a radio, as in the board.
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "cursor-pointer overflow-hidden rounded-card border-0 bg-card p-0 text-left",
        selected ? "shadow-[0_0_0_2px_var(--primary),0_4px_14px_color-mix(in_srgb,var(--primary)_14%,transparent)]" : "shadow-control",
      )}
    >
      {/* The preview paints the preset's own colors, not the page's tokens. */}
      <span aria-hidden="true" className="flex h-[110px]" style={{ background: s.ground }}>
        <span className="box-border flex w-[34%] flex-col gap-1.5 px-2 py-2.5" style={{ background: s.side, boxShadow: sideShadow }}>
          <span className="h-2 w-3/5 rounded-[3px]" style={{ background: s.accent }} />
          <span className="h-1.5 w-4/5 rounded-[3px]" style={{ background: s.muted }} />
          <span className="h-1.5 w-[70%] rounded-[3px]" style={{ background: s.muted }} />
          <span className="h-1.5 w-3/4 rounded-[3px]" style={{ background: s.muted }} />
        </span>
        <span className="box-border flex flex-1 flex-col gap-1.5 p-2.5">
          <span className="h-[9px] w-1/2 rounded-[3px]" style={{ background: s.text }} />
          <span className="flex-1" style={{ borderRadius: s.radius, background: s.card, boxShadow: cardShadow }} />
          <span
            className="h-3.5 w-2/5"
            style={{
              borderRadius: s.radius,
              background: s.accent,
              boxShadow: soft ? `0 2px 6px color-mix(in srgb, ${s.accent} 28%, transparent)` : "none",
            }}
          />
        </span>
      </span>
      <span className="flex flex-col gap-0.5 border-t border-divider px-3 py-2.5">
        <b className="text-[13.5px] font-semibold text-foreground">{t(`settingsAppearance.presets.${preset}.name`)}</b>
        <span className="text-xs text-muted-foreground">{t(`settingsAppearance.presets.${preset}.description`)}</span>
      </span>
    </button>
  );
}

/**
 * After a save: the shared boot state (lib/theme.ts) refetches settings.boot
 * and repaints title, favicon and theme. Then the saved appearance is
 * painted once more, in case the shared state already had that revision.
 */
async function refreshBoot(): Promise<void> {
  await refreshSharedBoot();
  try {
    paintAppearance(await opClient.call(settings.boot, {}));
  } catch {
    // The settings themselves were saved; the next page load paints them.
  }
}

const guideTokens = [
  "--primary",
  "--primary-foreground",
  "--background",
  "--card",
  "--foreground",
  "--muted-foreground",
  "--border",
  "--radius",
];

/** The custom CSS guide under the editor: the tokens, the dark class, one preset, and the order. */
function CssGuide() {
  const code = (text: string) => (
    <code
      key={text}
      className="rounded-chip bg-terminal-field px-1 py-px font-mono text-[11.5px] whitespace-nowrap text-terminal-foreground"
    >
      {text}
    </code>
  );
  const items: [string, Record<string, React.ReactNode>][] = [
    [t("settingsAppearance.css.guide.tokens"), { tokens: joined(guideTokens.map(code)) }],
    [t("settingsAppearance.css.guide.accent"), { primary: code("--primary") }],
    [t("settingsAppearance.css.guide.dark"), { root: code(":root"), dark: code(":root.dark") }],
    [t("settingsAppearance.css.guide.preset"), { preset: code(':root[data-theme="clay"]'), ids: joined(settings.themePresets.map(code)) }],
    [t("settingsAppearance.css.guide.order"), { root: code(":root") }],
  ];
  return (
    <div className="flex flex-col gap-1.5 bg-terminal-bar px-[18px] py-3.5 text-xs leading-relaxed text-terminal-muted">
      <h3 className="m-0 text-[12.5px] font-semibold text-terminal-foreground">{t("settingsAppearance.css.guide.title")}</h3>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {items.map(([text, values]) => (
          <li key={text}>{fill(text, values)}</li>
        ))}
      </ul>
    </div>
  );
}

/** Code chips with ", " between them. */
function joined(nodes: React.ReactElement[]): React.ReactNode {
  return nodes.map((node, i) => (
    <Fragment key={node.key}>
      {i > 0 && ", "}
      {node}
    </Fragment>
  ));
}

/** A translated sentence with its {placeholders} replaced by nodes (code chips). */
function fill(text: string, values: Record<string, React.ReactNode>): React.ReactNode {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const name = part.match(/^\{(\w+)\}$/)?.[1];
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed sentence, which never reorder.
    return <Fragment key={i}>{name && name in values ? values[name] : part}</Fragment>;
  });
}
