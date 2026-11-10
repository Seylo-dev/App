// An app's logo on a neutral tile (the logo-tile token, light in every
// preset), or its initial on a stable tint when it has none or the image
// does not load. Same size either way, so cards never shift.

import { cn } from "@seylo/ui/lib/utils";
import { useState } from "react";

const tints = [
  "bg-chip-blue-bg text-chip-blue-fg",
  "bg-chip-amber-bg text-chip-amber-fg",
  "bg-chip-violet-bg text-chip-violet-fg",
  "bg-chip-sky-bg text-chip-sky-fg",
  "bg-chip-green-bg text-chip-green-fg",
  "bg-chip-red-bg text-chip-red-fg",
  "bg-chip-gray-bg text-chip-gray-fg",
];

function tintFor(slug: string): string {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return tints[hash % tints.length] as string;
}

/** The logo to show: none when there is no URL or this one failed to load (a new URL is tried again). */
export function logoSource(logoUrl: string | null, failed: string | null): string | null {
  return logoUrl && failed !== logoUrl ? logoUrl : null;
}

export function TemplateLogo({ slug, name, logoUrl, size = 36 }: { slug: string; name: string; logoUrl: string | null; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = logoSource(logoUrl, failed);
  return (
    // Hidden from screen readers: the app's name is always written next to it.
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-[9px] font-semibold",
        src ? "bg-logo-tile" : tintFor(slug),
      )}
      style={{ width: size, height: size, fontSize: size * 0.42, padding: src ? Math.round(size * 0.17) : undefined }}
    >
      {src ? <img src={src} alt={name} className="size-full object-contain" onError={() => setFailed(src)} /> : name.charAt(0)}
    </span>
  );
}
