import { cn } from "@seylo/ui/lib/utils";
import { IconLock } from "@tabler/icons-react";

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

/** The square with a project's initial; the protected Panel project shows a lock. */
export function ProjectTile({
  id,
  name,
  isProtected = false,
  size = "sm",
}: {
  id: string;
  name: string;
  isProtected?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center font-semibold",
        size === "sm" ? "size-5 rounded-chip text-[11px]" : "size-8 rounded-control text-[13px]",
        isProtected ? "bg-chip-gray-bg text-chip-gray-fg" : tintFor(id),
      )}
    >
      {isProtected ? <IconLock size={size === "sm" ? 11 : 15} stroke={2.4} /> : name.charAt(0).toUpperCase()}
    </span>
  );
}
