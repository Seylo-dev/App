// The CSS for a saved accent color (Settings > Appearance). It replaces
// every token that carries the brand color, not only the primary: links,
// the focus ring, the selected nav item, the first chart series, the node
// card and the primary button's glow. The doubled :root outranks the
// presets' :root[data-theme="..."] rules, so it wins on every preset. Dark
// presets get lighter shades for text on dark ground.
//
// The panel writes the first paint with its own accentCss
// (apps/panel/src/modules/settings/boot.ts); lib/theme.ts rewrites the
// element with this one as soon as the app starts.

const darkPresets = ':root:root[data-theme="seylo-night"],:root:root[data-theme="midnight"]';

/** CSS for an accent "#RRGGBB"; "" for null or anything else (typed input never reaches the page). */
export function accentCss(accent: string | null): string {
  if (!accent || !/^#[0-9a-fA-F]{6}$/.test(accent)) return "";
  const a = accent;
  return (
    `:root:root,:root:root[data-theme]{--primary:${a};--ring:${a};--chart-1:${a};` +
    `--link:color-mix(in oklab,${a} 85%,#000);--link-hover:color-mix(in oklab,${a} 65%,#000);` +
    `--accent:color-mix(in oklab,${a} 13%,var(--card));--accent-foreground:color-mix(in oklab,${a} 85%,#000);` +
    `--highlight:linear-gradient(160deg,color-mix(in oklab,${a} 13%,var(--card)) 0%,var(--card) 100%);}` +
    `:root:root:not([data-theme]){--shadow-primary:0 1px 2px color-mix(in srgb,${a} 30%,transparent),0 4px 12px color-mix(in srgb,${a} 18%,transparent);}` +
    `${darkPresets}{--link:color-mix(in oklab,${a} 70%,#fff);--link-hover:color-mix(in oklab,${a} 50%,#fff);` +
    `--accent:color-mix(in oklab,${a} 22%,var(--card));--accent-foreground:color-mix(in oklab,${a} 60%,#fff);}`
  );
}
