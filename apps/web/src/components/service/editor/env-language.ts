// The "env" language for Monaco: a Monarch tokenizer for .env files with
// ${{service.VARIABLE}} references. Colors match Environment.dc.html: keys
// blue, "=" muted, comments grey italic, references violet. The violet
// pill behind a reference and the red squiggles come from decorations and
// markers built from @seylo/env-analyzer (env-model.ts), not from here.

import type * as Monaco from "monaco-editor/editor/editor.api";

export const envLanguageId = "seylo-env";

export const envMonarch: Monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenizer: {
    // Monarch has no end-of-line event, so values are tokenized in root:
    // the key rule only matches at the start of a line.
    root: [
      [/^\s*#.*$/, "comment"],
      // Monarch needs every group to match, so "export KEY=" and "KEY=" are two rules.
      [/^(\s*)(export\s+)([A-Za-z_][A-Za-z0-9_.-]*)(\s*)(=)/, ["", "keyword", "env.key", "", "delimiter"]],
      [/^(\s*)([A-Za-z_][A-Za-z0-9_.-]*)(\s*)(=)/, ["", "env.key", "", "delimiter"]],
      [/^\s*[^\s#].*$/, "invalid"],
      [/"/, { token: "string.quote", next: "@double" }],
      [/'/, { token: "string.quote", next: "@single" }],
      [/\$\{\{[^}\n]*\}\}/, "env.reference"],
      [/\$\{\{[^}\n]*$/, "env.reference.invalid"],
      [/\s+#.*$/, "comment"],
      [/[^$"'\s#]+/, "env.value"],
      [/./, "env.value"],
    ],
    // Double-quoted values may span lines; references work inside them.
    double: [
      [/\$\{\{[^}\n]*\}\}/, "env.reference"],
      [/\\./, "string.escape"],
      [/"/, { token: "string.quote", next: "@pop" }],
      [/[^"\\$]+/, "string"],
      [/./, "string"],
    ],
    single: [
      [/'/, { token: "string.quote", next: "@pop" }],
      [/[^']+/, "string"],
    ],
  },
};

let registered = false;

export function registerEnvLanguage(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: envLanguageId, extensions: [".env"], filenames: [".env"], aliases: ["env"] });
  monaco.languages.setMonarchTokensProvider(envLanguageId, envMonarch);
  monaco.languages.setLanguageConfiguration(envLanguageId, {
    comments: { lineComment: "#" },
    brackets: [["{", "}"]],
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "{", close: "}" },
    ],
  });
}
