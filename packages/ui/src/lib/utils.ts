import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge with the theme's own shadows (tailwind.css): without them
 * it reads `shadow-segment` as a shadow color, keeps it next to a later
 * `shadow-none`, and the stylesheet's order picks the winner.
 */
const merge = extendTailwindMerge({
  extend: { theme: { shadow: ["card", "control", "primary", "segment", "popover", "sidebar", "button"] } },
});

/** Joins class names and lets later Tailwind classes override earlier ones. */
export function cn(...inputs: ClassValue[]) {
  return merge(clsx(inputs));
}
