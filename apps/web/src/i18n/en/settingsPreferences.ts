// English strings: settingsPreferences. See ../t.ts for keys, placeholders and plurals.

export default {
  title: "Preferences",
  subtitle: "Choices that only change what you see. They follow you to every browser you sign in on.",
  sidebar: {
    title: "Sidebar",
    description: 'Hide a project from its "..." menu in the sidebar or on its home page card.',
    showHidden: "Show hidden projects in the sidebar",
    showHiddenHint:
      "When off, hidden projects still show on the home page under Show hidden, in search, at their links, and in the sidebar while you are in one.",
  },
  saveFailed: "Could not save your preferences",
} as const;
