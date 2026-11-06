// Monaco with just what the custom CSS editor needs: the core editor, its
// standard features, the CSS tokenizer and the editor worker. No CSS
// language service, so no extra worker. Loaded on demand through
// loadCssMonaco() so it lands in its own chunk (and shares Monaco's chunks
// with the service editors).

import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/features/register.all";
import "monaco-editor/languages/definitions/css/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

// Every editor in the app only needs the plain editor worker, so this
// agrees with any other screen that sets it first.
self.MonacoEnvironment ??= { getWorker: () => new EditorWorker() };

/** A dark theme painted from the page's terminal tokens, so it follows the preset. */
export function defineCssTheme(): string {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => toHex(style.getPropertyValue(name).trim()) ?? fallback;
  const name = "seylo-custom-css";
  monaco.editor.defineTheme(name, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": token("--terminal", "#0b1020"),
      "editor.foreground": token("--terminal-foreground", "#d6dce8"),
      "editorLineNumber.foreground": token("--terminal-muted", "#747e94"),
      "editor.lineHighlightBackground": token("--terminal-bar", "#11172a"),
    },
  });
  return name;
}

/** "#0b1020" or "rgb(11 16 32)" -> "#0b1020"; null for anything else. */
function toHex(value: string): string | null {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const match = value.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  if (!match) return null;
  return `#${match
    .slice(1, 4)
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .join("")}`;
}

export { monaco };
