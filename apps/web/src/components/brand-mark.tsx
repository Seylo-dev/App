// The product mark from the design, or the panel's own logo when one is
// uploaded (Settings > Appearance). The dark logo is used on dark presets.

import { useBoot } from "../lib/theme";

const darkPresets = new Set(["seylo-night", "midnight"]);

export function BrandMark({ size = 28 }: { size?: number }) {
  const boot = useBoot();
  const dark = darkPresets.has(document.documentElement.dataset.theme ?? "");
  const logo = (dark ? boot?.logoDark : boot?.logoLight) ?? boot?.logoLight ?? null;
  if (logo) return <img src={logo} alt="" height={size} className="max-w-[120px] shrink-0 object-contain" style={{ height: size }} />;
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" className="shrink-0">
      <rect width="28" height="28" rx="7" className="fill-primary" />
      <path
        d="M18.5 9.2c-1.4-1.3-3.4-1.8-5.2-1.3-2.4.6-3.2 3.1-1.2 4.4.9.6 2.2.9 3.4 1.3 2.6.8 3 3.6.7 4.9-1.9 1.1-4.5.7-6.1-.8"
        className="stroke-primary-foreground"
        strokeWidth="2.1"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
