// English strings: templates. See ../t.ts for keys, placeholders and plurals.

export default {
  subtitle: "One click installs normal services you can change afterwards.",
  search: "Search templates",
  searchCount: { one: "Search {count} template", other: "Search {count} templates" },
  categories: "Categories",
  all: "All",
  empty: "No templates match",
  emptyHint: "Try another word or category.",
  install: "Install {name}",
  installing: "Installing",
  installed: "{name} installed.",
  serviceName: "Service name",
  optional: "{label} (optional)",
  passwordHint: "Leave empty to generate one.",
  domainHint: "Leave empty for the node's automatic domain.",
  automatic: "automatic",
  port: "port {port}",
  conflict: "name taken",
  previewPending: "Fill in the form to see what gets created.",
  secretsGenerated: "Passwords and keys are generated for you.",
  sandboxed: "Template code is reviewed and runs sandboxed.",
} as const;
