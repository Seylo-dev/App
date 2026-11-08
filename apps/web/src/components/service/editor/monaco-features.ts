// The editor contributions our Monaco editors load: what someone editing an
// env file, a compose file, notes or custom CSS reaches for, and nothing
// that needs a language service we do not run. Both loaders (monaco.ts and
// settings/appearance/monaco-css.ts) import this, so they share one chunk.
// monaco-editor/features/register.all would add every contribution
// (inline completions, sticky scroll, code lens, inlay hints, the color
// picker, the GPU renderer, the command palette...): 3.9 MB minified. The
// custom CSS editor adds the color picker on its own.
//
// features/suggest/register pulls in inline completions as well, so the
// suggest widget comes from its controller directly.

import "monaco-editor/features/codeEditor/register";
import "monaco-editor/features/codicon/register";
// What the env editor registers providers for: hover, completions, quick fixes, and its markers (F8).
import "monaco-editor/features/hover/register";
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/features/snippet/register";
import "monaco-editor/features/codeAction/register";
import "monaco-editor/features/gotoError/register";
// Editing basics: find, the context menu with cut / copy / paste, word and line moves,
// comments, several cursors, brackets, folding, and Ctrl+M to leave the editor with Tab.
import "monaco-editor/features/find/register";
import "monaco-editor/features/contextmenu/register";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/wordOperations/register";
import "monaco-editor/features/linesOperations/register";
import "monaco-editor/features/lineSelection/register";
import "monaco-editor/features/comment/register";
import "monaco-editor/features/multicursor/register";
import "monaco-editor/features/cursorUndo/register";
import "monaco-editor/features/smartSelect/register";
import "monaco-editor/features/indentation/register";
import "monaco-editor/features/bracketMatching/register";
import "monaco-editor/features/wordHighlighter/register";
import "monaco-editor/features/folding/register";
import "monaco-editor/features/dnd/register";
import "monaco-editor/features/readOnlyMessage/register";
import "monaco-editor/features/toggleTabFocusMode/register";
import "monaco-editor/features/iPadShowKeyboard/register";
// Invisible and look-alike characters in a pasted value, and stray line terminators, stand out.
import "monaco-editor/features/unicodeHighlighter/register";
import "monaco-editor/features/unusualLineTerminators/register";
