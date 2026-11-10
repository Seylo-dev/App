// The Avatar card on Settings > Personal details: the avatar in use, Upload
// image (cropped and scaled in the browser, lib/avatar-image.ts), Remove
// image while an upload shows, and the generated faces to pick from.

import { auth, avatars, isAvatarStyle, type OpOutput } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Avatar } from "@seylo/ui/components/avatar";
import { Button } from "@seylo/ui/components/button";
import { SectionCard, SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { ButtonSkeleton, Skeleton } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { IconLoader2, IconUpload } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { t } from "../../../i18n/t";
import { AvatarImageError, avatarAccept, squareAvatar } from "../../../lib/avatar-image";
import { useSettingsMutation } from "../mutation";
import { QueryView } from "../op-state";
import { AvatarPicker, type PresetChoice } from "./avatar-picker";

type AvatarState = OpOutput<typeof avatars.mine>["avatar"];

/** Everything that shows an avatar refetches after a change. */
const refresh = [avatars.mine, auth.whoami];

export function AvatarCard({ name }: { name: string }) {
  const mine = useOp(avatars.mine, {});
  return (
    <QueryView query={mine} skeleton={<AvatarCardSkeleton />}>
      {(data) => <AvatarEditor avatar={data.avatar} name={name} />}
    </QueryView>
  );
}

function AvatarEditor({ avatar, name }: { avatar: AvatarState; name: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  const upload = useSettingsMutation(avatars.upload, { invalidates: refresh, success: t("settingsProfile.avatar.uploaded") });
  const remove = useSettingsMutation(avatars.removeUpload, { invalidates: refresh, success: t("settingsProfile.avatar.removed") });
  const pick = useSettingsMutation(avatars.setPreset, { invalidates: refresh, success: t("settingsProfile.avatar.picked") });
  const busy = preparing || upload.isPending || remove.isPending || pick.isPending;
  const uploaded = avatar.kind === "upload";
  const selected: PresetChoice | null = !uploaded && isAvatarStyle(avatar.style) ? { style: avatar.style, seed: avatar.seed } : null;

  async function choose(file: File | undefined) {
    if (!file) return;
    setPreparing(true);
    try {
      upload.mutate({ dataUrl: await squareAvatar(file) });
    } catch (error) {
      const problem = error instanceof AvatarImageError ? error.problem : "unreadable";
      toast.error(t(`settingsProfile.avatar.problems.${problem}`));
    } finally {
      setPreparing(false);
    }
  }

  return (
    <SectionCard title={t("settingsProfile.avatar.title")} description={t("settingsProfile.avatar.description")}>
      <div className="flex flex-col gap-5">
        {/* One row on a phone too: the hint wraps beside the picture instead of pushing the buttons under it. */}
        <div className="flex items-center gap-4">
          <div className="relative shrink-0">
            <Avatar name={name} src={avatar.url} alt={t("settingsProfile.avatar.yours")} size="xl" />
            {busy && (
              <span className="absolute inset-0 flex items-center justify-center rounded-full bg-card/70 text-foreground">
                <IconLoader2 size={20} className="animate-spin" aria-hidden="true" />
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
                <IconUpload size={15} stroke={1.8} aria-hidden="true" />
                {uploaded ? t("settingsProfile.avatar.uploadAnother") : t("settingsProfile.avatar.upload")}
              </Button>
              {uploaded && (
                <Button variant="ghost" disabled={busy} onClick={() => remove.mutate({})}>
                  {t("settingsProfile.avatar.remove")}
                </Button>
              )}
            </div>
            <span className="text-xs text-muted-foreground">{t("settingsProfile.avatar.uploadHint")}</span>
          </div>
          <input
            ref={input}
            type="file"
            accept={avatarAccept}
            aria-label={t("settingsProfile.avatar.upload")}
            className="hidden"
            onChange={(e) => {
              void choose(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>

        <div className="flex flex-col gap-3 border-t border-divider pt-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-[13.5px] font-medium">{t("settingsProfile.avatar.generated")}</span>
            <span className="text-[12.5px] text-muted-foreground">{t("settingsProfile.avatar.generatedHint")}</span>
          </div>
          <AvatarPicker selected={selected} pending={busy} onPick={(choice) => pick.mutate(choice)} />
        </div>
      </div>
    </SectionCard>
  );
}

/** The card while the avatar loads: the round preview, the buttons, a row of faces. */
function AvatarCardSkeleton() {
  return (
    <SectionCardSkeleton titleWidth="w-16" description="w-96">
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-4">
          <Skeleton className="size-20 rounded-full" />
          <div className="flex flex-col gap-2">
            <ButtonSkeleton className="w-36" />
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-divider pt-4">
          <ButtonSkeleton className="w-48" />
          <div className="flex gap-2.5">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="size-14 rounded-full" />
            ))}
          </div>
        </div>
      </div>
    </SectionCardSkeleton>
  );
}
