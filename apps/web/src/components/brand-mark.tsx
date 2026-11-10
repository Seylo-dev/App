// The product mark from the design, or the panel's own logo when one is
// uploaded (Settings > Appearance). The dark logo shows while the dark half
// of the theme does, and switches with it.

import { useBoot, useDarkMode } from "../lib/theme";

export function BrandMark({ size = 28 }: { size?: number }) {
  const boot = useBoot();
  const dark = useDarkMode();
  const logo = (dark ? boot?.logoDark : boot?.logoLight) ?? boot?.logoLight ?? null;
  if (logo) return <img src={logo} alt="" height={size} className="max-w-[120px] shrink-0 object-contain" style={{ height: size }} />;
  return <ProductMark size={size} />;
}

/** The built-in mark, in the accent color: what the panel shows while no logo is uploaded. */
export function ProductMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" className="shrink-0">
      <rect width="28" height="28" rx="7" className="fill-primary" />
      {/* Three layers, the middle one sliding in: a new release joining a live stack. */}
      <rect x="5.5" y="6.25" width="13.5" height="4" rx="1.5" className="fill-primary-foreground" />
      <rect x="9" y="12" width="13.5" height="4" rx="1.5" className="fill-primary-foreground" />
      <rect x="5.5" y="17.75" width="13.5" height="4" rx="1.5" className="fill-primary-foreground" />
    </svg>
  );
}
