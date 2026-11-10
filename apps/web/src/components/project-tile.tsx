import { cn } from "@seylo/ui/lib/utils";
import { IconLock } from "@tabler/icons-react";
import { useState } from "react";

const tints = [
  "bg-chip-blue-bg text-chip-blue-fg",
  "bg-chip-amber-bg text-chip-amber-fg",
  "bg-chip-violet-bg text-chip-violet-fg",
  "bg-chip-sky-bg text-chip-sky-fg",
  "bg-chip-green-bg text-chip-green-fg",
  "bg-chip-red-bg text-chip-red-fg",
];

/** Stable tint per project, so a project keeps its color everywhere. */
function tintFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return tints[hash % tints.length] as string;
}

const sizes = {
  sm: { box: "size-5 rounded-chip text-[11px]", lock: 11 },
  md: { box: "size-8 rounded-control text-[13px]", lock: 15 },
  lg: { box: "size-16 rounded-card text-[24px]", lock: 26 },
} as const;

/**
 * The square with a project's image (projects.setImage) or its initial; the
 * protected Panel project shows a lock until it has an image. An image that
 * fails to load falls back to the initial.
 */
export function ProjectTile({
  id,
  name,
  imageUrl = null,
  isProtected = false,
  size = "sm",
}: {
  id: string;
  name: string;
  imageUrl?: string | null;
  isProtected?: boolean;
  size?: keyof typeof sizes;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const { box, lock } = sizes[size];
  if (imageUrl && failed !== imageUrl) {
    return (
      <img
        aria-hidden="true"
        alt=""
        src={imageUrl}
        draggable={false}
        onError={() => setFailed(imageUrl)}
        className={cn("shrink-0 bg-muted object-cover", box)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center font-semibold",
        box,
        isProtected ? "bg-chip-gray-bg text-chip-gray-fg" : tintFor(id),
      )}
    >
      {isProtected ? <IconLock size={lock} stroke={2.4} /> : name.charAt(0).toUpperCase()}
    </span>
  );
}
