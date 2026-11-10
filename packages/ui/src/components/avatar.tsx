import { Avatar as AvatarPrimitive } from "radix-ui";
import { cn } from "../lib/utils";

const tints = [
  "bg-chip-blue-bg text-chip-blue-fg",
  "bg-chip-violet-bg text-chip-violet-fg",
  "bg-chip-green-bg text-chip-green-fg",
  "bg-chip-amber-bg text-chip-amber-fg",
  "bg-chip-sky-bg text-chip-sky-fg",
  "bg-chip-red-bg text-chip-red-fg",
] as const;

/** Up to two initials from a name or email. */
export function initials(name: string): string {
  const base = name.includes("@") ? (name.split("@")[0] ?? name) : name;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  const first = words[0]?.[0] ?? "";
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : (words[0]?.[1] ?? "");
  return (first + second).toUpperCase();
}

function tintFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return tints[h % tints.length] as string;
}

const sizes = {
  xs: "size-5 text-[9px]",
  sm: "size-6 text-[10px]",
  default: "size-8 text-[12px]",
  lg: "size-10 text-[14px]",
  xl: "size-20 text-[26px]",
} as const;

/** How long a loading image may take before the initials show (a cached avatar is there sooner, so they never flash). */
const fallbackDelayMs = 400;

/**
 * A round avatar: the image when it loads, otherwise tinted initials (the
 * tint is stable per name), also when the image fails. `decorative` hides
 * it from screen readers where the name is written right next to it.
 */
export function Avatar({
  name,
  src,
  alt = name,
  decorative = false,
  size = "default",
  className,
}: {
  name: string;
  src?: string | null;
  /** The image's alt text; the name by default. */
  alt?: string;
  decorative?: boolean;
  size?: keyof typeof sizes;
  className?: string;
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      aria-hidden={decorative || undefined}
      className={cn("relative inline-flex shrink-0 overflow-hidden rounded-full bg-muted", sizes[size], className)}
    >
      {src && <AvatarPrimitive.Image src={src} alt={decorative ? "" : alt} className="size-full object-cover" />}
      <AvatarPrimitive.Fallback
        delayMs={src ? fallbackDelayMs : undefined}
        className={cn("flex size-full items-center justify-center font-semibold", tintFor(name))}
        aria-label={decorative ? undefined : alt}
      >
        {initials(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
