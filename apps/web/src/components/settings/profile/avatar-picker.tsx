// Generated avatars (after Clipnest's picker): a face is just a style and a
// seed, so a style picker, six faces and Randomize (six new seeds) are the
// whole UI. The panel draws the faces (presetAvatarPath), so nothing loads
// from DiceBear's servers. Picking a face saves it at once. The credit line
// names the style's artwork, its creator and license.

import { type AvatarStyleId, avatarStyles, defaultAvatarStyle, isAvatarStyle, presetAvatarPath, randomAvatarSeed } from "@seylo/ops";
import { Button } from "@seylo/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { cn } from "@seylo/ui/lib/utils";
import { IconDice5 } from "@tabler/icons-react";
import { Fragment, useState } from "react";
import { t } from "../../../i18n/t";

const batchSize = 6;

const freshSeeds = () => Array.from({ length: batchSize }, randomAvatarSeed);

export interface PresetChoice {
  style: AvatarStyleId;
  seed: string;
}

export function AvatarPicker({
  selected,
  pending,
  onPick,
}: {
  /** The face in use (null while an uploaded image is shown, so no face is marked). */
  selected: PresetChoice | null;
  pending: boolean;
  onPick: (choice: PresetChoice) => void;
}) {
  const [style, setStyle] = useState<AvatarStyleId>(selected?.style ?? defaultAvatarStyle);
  // The face in use comes first, so it shows marked until the person rolls new ones.
  const [seeds, setSeeds] = useState<string[]>(() => (selected ? [selected.seed, ...freshSeeds().slice(1)] : freshSeeds()));
  const info = avatarStyles.find((s) => s.id === style) ?? avatarStyles[0];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="avatar-style" className="text-[12.5px] font-medium text-ink-strong">
            {t("settingsProfile.avatar.style")}
          </label>
          <Select
            value={style}
            onValueChange={(next) => {
              if (!isAvatarStyle(next)) return;
              setStyle(next);
              setSeeds(freshSeeds());
            }}
          >
            <SelectTrigger id="avatar-style" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {avatarStyles.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="secondary" onClick={() => setSeeds(freshSeeds())}>
          <IconDice5 size={15} stroke={1.8} aria-hidden="true" />
          {t("settingsProfile.avatar.randomize")}
        </Button>
      </div>

      <ul aria-label={t("settingsProfile.avatar.generated")} className="m-0 flex list-none flex-wrap gap-2.5 p-0">
        {seeds.map((seed) => {
          const current = selected?.style === style && selected.seed === seed;
          return (
            <li key={`${style}/${seed}`}>
              <button
                type="button"
                aria-label={t("settingsProfile.avatar.use")}
                aria-pressed={current}
                disabled={pending}
                onClick={() => {
                  if (!current) onPick({ style, seed });
                }}
                className={cn(
                  "flex size-14 cursor-pointer items-center justify-center rounded-full p-0.5 ring-2 transition duration-200 disabled:cursor-default",
                  current ? "ring-primary" : "ring-transparent hover:ring-input",
                )}
              >
                <img src={presetAvatarPath(style, seed)} alt="" width={52} height={52} className="size-full rounded-full bg-muted" />
              </button>
            </li>
          );
        })}
      </ul>

      {info && <Credit work={info.work} creator={info.creator} source={info.source} license={info.license} licenseUrl={info.licenseUrl} />}
    </div>
  );
}

/** "{work} by {creator}, {license}." with the work and the license as links. */
function Credit({
  work,
  creator,
  source,
  license,
  licenseUrl,
}: {
  work: string;
  creator: string;
  source: string;
  license: string;
  licenseUrl: string;
}) {
  const parts = t("settingsProfile.avatar.drawnBy").split(/(\{\w+\})/);
  const link = "text-muted-foreground underline decoration-ink-ghost underline-offset-2 transition duration-200 hover:text-foreground";
  return (
    <p className="m-0 text-xs text-muted-foreground">
      {parts.map((part, i) => {
        const key = `${i}-${part}`;
        if (part === "{work}")
          return (
            <a key={key} href={source} target="_blank" rel="noreferrer noopener" className={link}>
              {work}
            </a>
          );
        if (part === "{license}")
          return (
            <a key={key} href={licenseUrl} target="_blank" rel="noreferrer noopener" className={link}>
              {license}
            </a>
          );
        return <Fragment key={key}>{part === "{creator}" ? creator : part}</Fragment>;
      })}
    </p>
  );
}
