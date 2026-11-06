import { cn } from "@seylo/ui/lib/utils";
import { t } from "../../i18n/t";
import { kindLook, type ServiceKind } from "./status";

const badgeTones = {
  blue: "bg-chip-blue-bg text-chip-blue-fg",
  sky: "bg-chip-sky-bg text-chip-sky-fg",
  red: "bg-chip-red-bg text-chip-red-fg",
  violet: "bg-chip-violet-bg text-chip-violet-fg",
  gray: "bg-chip-gray-bg text-chip-gray-fg",
  green: "bg-chip-green-bg text-chip-green-fg",
  amber: "bg-chip-amber-bg text-chip-amber-fg",
  track: "bg-track text-ink-strong",
} as const;

/** The APP / PG / RDS tile in front of a service name. */
export function KindBadge({ kind, size = "md", className }: { kind: ServiceKind; size?: "sm" | "md"; className?: string }) {
  const look = kindLook[kind];
  return (
    <span
      title={t(look.label)}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-chip font-mono font-semibold",
        size === "md" ? "h-7 w-[38px] text-[11px]" : "h-6 w-[34px] text-[10.5px]",
        badgeTones[look.tone],
        className,
      )}
    >
      {look.badge}
    </span>
  );
}

export { badgeTones };
