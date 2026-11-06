// One branding image tile (logo for light, logo for dark, favicon): click
// to pick a file, it uploads at once; the current image shows inside the
// tile with a remove button. The dark-logo tile sits on a dark ground, as
// in the Appearance board.

import { settings } from "@seylo/ops";
import { Button } from "@seylo/ui/components/button";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import { IconLoader2, IconX } from "@tabler/icons-react";
import { useRef } from "react";
import { t } from "../../../i18n/t";
import { useSettingsMutation } from "../mutation";
import { brandFileProblem, brandTypes } from "./presets";

type Kind = settings.BrandAssetKind;

const refresh = [settings.branding, settings.boot];

export function BrandAssetTile({
  kind,
  url,
  disabled,
  onChanged,
}: {
  kind: Kind;
  url: string | null;
  disabled: boolean;
  onChanged: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useSettingsMutation(settings.uploadBrandAsset, {
    invalidates: refresh,
    success: t("settingsAppearance.branding.uploaded"),
    onSuccess: onChanged,
  });
  const remove = useSettingsMutation(settings.removeBrandAsset, {
    invalidates: refresh,
    success: t("settingsAppearance.branding.removed"),
    onSuccess: onChanged,
  });
  const busy = upload.isPending || remove.isPending;
  const dark = kind === "logoDark";

  function pick(file: File | undefined) {
    if (!file) return;
    const problem = brandFileProblem(file);
    if (problem) {
      toast.error(t(`settingsAppearance.branding.problems.${problem}`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => upload.mutate({ kind, dataUrl: String(reader.result) });
    reader.onerror = () => toast.error(t("settingsAppearance.branding.readFailed"));
    reader.readAsDataURL(file);
  }

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => input.current?.click()}
        aria-label={t(`settingsAppearance.branding.kinds.${kind}`)}
        className={cn(
          "flex h-[72px] w-full cursor-pointer items-center justify-center rounded-[10px] border border-dashed px-3 text-xs disabled:cursor-default",
          dark ? "border-terminal-muted/50 bg-terminal text-terminal-muted" : "border-input bg-raised text-muted-foreground",
        )}
      >
        {busy ? (
          <IconLoader2 size={16} className="animate-spin" />
        ) : url ? (
          <img src={url} alt="" className={cn("max-h-10 max-w-full object-contain", kind === "favicon" && "size-8")} />
        ) : (
          t(`settingsAppearance.branding.kinds.${kind}`)
        )}
      </button>
      {url && !disabled && (
        <Button
          size="icon"
          variant="secondary"
          aria-label={t("settingsAppearance.branding.remove", { what: t(`settingsAppearance.branding.kinds.${kind}`) })}
          className="absolute -top-2 -right-2 size-6 rounded-full"
          disabled={busy}
          onClick={() => remove.mutate({ kind })}
        >
          <IconX size={12} stroke={2.2} />
        </Button>
      )}
      <input
        ref={input}
        type="file"
        accept={brandTypes.join(",")}
        className="hidden"
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
