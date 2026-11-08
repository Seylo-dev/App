// Monaco, loaded on demand (it is large) with only what our editors use:
// the core editor, the contributions in monaco-features.ts (hover,
// suggest, quick fixes, find and the editing basics), the editor worker and
// a few languages. No language servers, so no TypeScript or JSON workers.
// Import this module only through loadMonaco() so it lands in its own chunk.

import * as monaco from "monaco-editor/editor/editor.api";
import "./monaco-features";
import "monaco-editor/languages/definitions/dockerfile/register";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/languages/definitions/html/register";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/ini/register";
import "monaco-editor/languages/definitions/shell/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/sql/register";
import "monaco-editor/languages/definitions/xml/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { registerEnvLanguage } from "./env-language";
import { defineSeyloThemes, followPageTheme } from "./theme";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

registerEnvLanguage(monaco);
defineSeyloThemes(monaco);
followPageTheme(monaco);

export { monaco };
export type Monaco = typeof monaco;
