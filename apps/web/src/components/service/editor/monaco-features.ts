// The editor contributions our Monaco editors load: what someone editing an
// env file, a compose file, notes or custom CSS reaches for, and nothing
// that needs a language service we do not run. Both loaders (monaco.ts and
// settings/appearance/monaco-css.ts) import this, so they share one chunk.
// monaco-editor/features/register.all would add every contribution
// (inline completions, sticky scroll, code lens, inlay hints, the color
// picker, the GPU renderer, the command palette...). The custom CSS editor
// adds the color picker on its own.
//
// Leaving those out takes the shared chunk from about 3.9 MB to 3.4 MB
// minified, no further: most of it is Monaco's core (editor/common,
// editor/browser, base/*, platform/*) and the diff editor widgets that
// editor.api itself imports. A much smaller chunk would need a different
// editor, not fewer contributions.
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
// URLs in a compose file, a Dockerfile, notes or a file are underlined and Ctrl+click opens them
// (http and https in a new window without an opener), and Ctrl+G goes to a line. The env editor
// turns links off. The command palette (F1) and font zoom, which only the palette reaches, stay out.
import "monaco-editor/features/links/register";
import "monaco-editor/features/gotoLine/register";
// Invisible and look-alike characters in a pasted value, and stray line terminators, stand out.
import "monaco-editor/features/unicodeHighlighter/register";
import "monaco-editor/features/unusualLineTerminators/register";
