// A template's logo, or its initial on a stable tint when it has none (or
// the image does not load).

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

export function TemplateLogo({ slug, name, logoUrl, size = 36 }: { slug: string; name: string; logoUrl: string | null; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = logoUrl && failed !== logoUrl ? logoUrl : null;
  return (
    <span
      aria-hidden="true"
      className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-[9px] font-semibold", !src && tintFor(slug))}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {src ? <img src={src} alt="" className="size-full object-contain" onError={() => setFailed(src)} /> : name.charAt(0)}
    </span>
  );
}
