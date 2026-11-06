// English strings: settingsAppearance. See ../t.ts for keys, placeholders and plurals.

export default {
  title: "Appearance",
  subtitle: "Theme, branding and custom CSS for everyone who uses this panel.",
  theme: "Theme",
  colorMode: "Color mode",
  modes: { light: "Light", dark: "Dark", system: "System" },
  preset: "Theme preset",
  presets: {
    seylo: { name: "Default", description: "Light and dark" },
    "seylo-night": { name: "Night", description: "Dark with ink blues" },
    classic: { name: "Classic", description: "Soft gray cards, green accent" },
    midnight: { name: "Midnight", description: "Dense, purple accent" },
  },
  fixedMode: "Classic is always light and Midnight always dark; the color mode only switches the Default theme.",
  accent: "Accent",
  presetAccent: "Theme's own",
  customAccent: "Custom accent color",
  branding: {
    title: "Branding",
    name: "Panel name",
    kinds: { logoLight: "Logo, light", logoDark: "Logo, dark", favicon: "Favicon" },
    remove: "Remove {what}",
    uploaded: "Image uploaded",
    removed: "Image removed",
    readFailed: "Could not read the file",
    problems: {
      type: "Use a PNG, SVG, WebP, JPEG or ICO file.",
      size: "The file is larger than 512 KB.",
    },
    loginMessage: "Sign-in page message",
    hidePoweredBy: 'Hide "Powered by {product}" in the footer',
  },
  css: {
    title: "Custom CSS",
    hint: "Applied after the theme · owner only",
    ownerOnly: "Only an owner can change the custom CSS.",
  },
} as const;
