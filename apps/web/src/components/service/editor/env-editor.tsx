// The Monaco .env editor (Environment.dc.html): the env tokenizer, violet
// reference pills, red squiggles and line backgrounds from env-analyzer,
// hovers with a reference's resolved value, ${{ completions, quick fixes
// for edit fixes (also the blue hint on a hardcoded service URL), secret
// values as dots until "Show values" is on (the line being edited shows its
// value), and a Secret chip after each variable builds and crash reports
// treat as a secret (Public after one that only looks like one), with a
// hover that says why and what it changes.

import { type AnalyzeContext, type AnalyzeResult, describeReference, LineIndex, referenceAt } from "@seylo/env-analyzer";
import type * as MonacoApi from "monaco-editor/editor/editor.api";
import { useEffect, useRef } from "react";
import { t } from "../../../i18n/t";
import { CodeEditor, type CodeEditorInstance } from "./code-editor";
import "./env-editor.css";
import { envLanguageId } from "./env-language";
import {
  completionTail,
  errorLines,
  problemMessage,
  quickFixActions,
  referenceHover,
  referenceRanges,
  referenceSuggestions,
  secretChips,
  secretRanges,
  toMarkers,
} from "./env-model";
import type { Monaco } from "./monaco";

export interface EnvEditorHandle {
  /** Inserts text at the cursor (or over the selection) and focuses the editor. */
  insert(text: string): void;
  /** Moves the cursor to a line and scrolls it into view. */
  revealLine(line: number): void;
  /** Applies text edits given as offsets into the current text. */
  applyEdits(edits: { start: number; end: number; text: string }[]): void;
}

export function EnvEditor({
  text,
  onChange,
  analysis,
  context,
  selfName,
  reveal,
  onSave,
  onCursor,
  onHandle,
  height = 420,
  readOnly = false,
}: {
  text: string;
  onChange: (text: string) => void;
  analysis: AnalyzeResult;
  context: AnalyzeContext | null;
  selfName: string;
  reveal: boolean;
  onSave: () => void;
  onCursor?: (line: number, column: number) => void;
  onHandle?: (handle: EnvEditorHandle | null) => void;
  height?: number | string;
  readOnly?: boolean;
}) {
  const editorRef = useRef<CodeEditorInstance | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorations = useRef<MonacoApi.editor.IEditorDecorationsCollection | null>(null);
  // The Secret / Public chips, apart from the rest, and the kind of each ("secret" or "public").
  const chipDecorations = useRef<MonacoApi.editor.IEditorDecorationsCollection | null>(null);
  const chipLabels = useRef<string[]>([]);
  // The line whose secret is shown because the cursor is on it (0: none).
  const editingLine = useRef(0);
  // Providers are registered once per editor and read the latest state from here.
  const state = useRef({ analysis, context, reveal, selfName });
  state.current = { analysis, context, reveal, selfName };

  const draw = () => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model) return;
    const { analysis: a, context: ctx, reveal: show, selfName: self } = state.current;
    monaco.editor.setModelMarkers(model, "env-analyzer", toMarkers(a.diagnostics, self));
    const range = (r: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) =>
      new monaco.Range(r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn);
    const items: MonacoApi.editor.IModelDeltaDecoration[] = [
      ...referenceRanges(a.parsed).map((r) => ({ range: range(r), options: { inlineClassName: "seylo-env-ref" } })),
      ...errorLines(a.diagnostics).map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: "seylo-env-error-line", lineNumberClassName: "seylo-env-error-number" },
      })),
      ...(show
        ? []
        : secretRanges(a.parsed)
            .filter((r) => r.startLineNumber !== editingLine.current)
            .map((r) => ({ range: range(r), options: { inlineClassName: "seylo-env-secret" } }))),
    ];
    decorations.current ??= editor.createDecorationsCollection();
    decorations.current.set(items);

    // The chips are injected text: setting one makes Monaco lay its line out again, which
    // loses keys typed meanwhile, so they are set only when a line's chip changes. A chip
    // stays at the end of its line as the text around it changes.
    const chips = secretChips(a.parsed, ctx, self).filter((chip) => chip.line <= model.getLineCount());
    const labels = chips.map((chip) => (chip.secret ? "secret" : "public"));
    chipDecorations.current ??= editor.createDecorationsCollection();
    const have = chipDecorations.current.getRanges().map((r, i) => `${r.endLineNumber}:${chipLabels.current[i]}`);
    const want = chips.map((chip, i) => `${chip.line}:${labels[i]}`);
    if (have.join(",") === want.join(",")) return;
    chipLabels.current = labels;
    chipDecorations.current.set(
      chips.map((chip) => {
        // After the line's last character, so a trailing comment stays next to its value.
        const end = model.getLineMaxColumn(chip.line);
        return {
          range: new monaco.Range(chip.line, end, chip.line, end),
          options: {
            // An empty range: without this Monaco drops its injected text.
            showIfCollapsed: true,
            after: {
              content: t(chip.secret ? "serviceEnv.secret.chip" : "serviceEnv.secret.chipPublic"),
              inlineClassName: chip.secret ? "seylo-env-chip seylo-env-chip-secret" : "seylo-env-chip seylo-env-chip-public",
              cursorStops: monaco.editor.InjectedTextCursorStops.None,
            },
          },
        };
      }),
    );
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: draw reads the latest state from the ref.
  useEffect(draw, [analysis, reveal, context]);

  const onReady = (editor: CodeEditorInstance, monaco: Monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    const disposables: MonacoApi.IDisposable[] = [];
    const offsetAt = (pos: MonacoApi.IPosition) => editor.getModel()?.getOffsetAt(pos) ?? 0;

    disposables.push(
      editor.onDidChangeCursorPosition((e) => {
        onCursor?.(e.position.lineNumber, e.position.column);
        const line = editor.hasTextFocus() ? e.position.lineNumber : 0;
        if (line !== editingLine.current) {
          editingLine.current = line;
          draw();
        }
      }),
      editor.onDidFocusEditorText(() => {
        editingLine.current = editor.getPosition()?.lineNumber ?? 0;
        draw();
      }),
      editor.onDidBlurEditorText(() => {
        editingLine.current = 0;
        draw();
      }),
      monaco.languages.registerHoverProvider(envLanguageId, {
        provideHover(model, position) {
          if (model !== editor.getModel()) return null;
          const { analysis: a, context: ctx, reveal: show, selfName: self } = state.current;
          const hit = referenceAt(a.parsed, offsetAt(position));
          if (!hit) {
            // A variable's name, or its chip at the end of the line: whether it is a secret, and why.
            const line = position.lineNumber;
            const chip = secretChips(a.parsed, ctx, self).find(
              (c) =>
                (c.line === line && position.column >= model.getLineMaxColumn(line)) ||
                (c.keyRange.startLineNumber === line &&
                  position.column >= c.keyRange.startColumn &&
                  position.column < c.keyRange.endColumn),
            );
            if (!chip) return null;
            const end = model.getLineMaxColumn(line);
            const k = chip.keyRange;
            const r =
              chip.line === line && position.column >= end
                ? new monaco.Range(line, end, line, end)
                : new monaco.Range(k.startLineNumber, k.startColumn, k.endLineNumber, k.endColumn);
            return { range: r, contents: chip.hover.map((value) => ({ value })) };
          }
          if (!ctx) return null;
          const r = hit.reference.range;
          const contents = referenceHover(describeReference(hit.reference, ctx), show).map((value) => ({ value }));
          return { range: new monaco.Range(r.startLine, r.startColumn, r.endLine, r.endColumn), contents };
        },
      }),
      monaco.languages.registerCompletionItemProvider(envLanguageId, {
        // "[" too: ${{api.DOMAINS[ lists the items of the list.
        triggerCharacters: ["{", ".", "["],
        provideCompletionItems(model, position) {
          if (model !== editor.getModel()) return { suggestions: [] };
          const ctx = state.current.context;
          if (!ctx) return { suggestions: [] };
          const line = model.getLineContent(position.lineNumber);
          const before = line.slice(0, position.column - 1);
          const open = before.lastIndexOf("${{");
          if (open === -1 || before.slice(open).includes("}}")) return { suggestions: [] };
          const closing = completionTail(line.slice(position.column - 1));
          const range = new monaco.Range(position.lineNumber, open + 1, position.lineNumber, position.column + closing);
          return {
            suggestions: referenceSuggestions(ctx).map((s) => ({
              label: s.label,
              kind: monaco.languages.CompletionItemKind.Variable,
              detail: s.detail,
              insertText: s.insertText,
              filterText: s.filterText,
              sortText: s.sortText,
              range,
              tags: s.reachable ? [] : [monaco.languages.CompletionItemTag.Deprecated],
            })),
          };
        },
      }),
      monaco.languages.registerCodeActionProvider(envLanguageId, {
        provideCodeActions(model, range) {
          if (model !== editor.getModel()) return { actions: [], dispose() {} };
          const { analysis: a, selfName: self } = state.current;
          const index = new LineIndex(a.parsed.text);
          const from = model.getOffsetAt(range.getStartPosition());
          const to = model.getOffsetAt(range.getEndPosition());
          // Fixes of errors and of hints (a hardcoded URL's "Use ${{api.URL}}"), each with its own severity.
          const actions: MonacoApi.languages.CodeAction[] = quickFixActions(a.diagnostics, from, to, self).map((action) => {
            const d = action.diagnostic;
            return {
              title: action.title,
              kind: "quickfix",
              isPreferred: action.isPreferred,
              diagnostics: [
                {
                  severity: action.severity,
                  message: problemMessage(d),
                  startLineNumber: d.range.startLine,
                  startColumn: d.range.startColumn,
                  endLineNumber: d.range.endLine,
                  endColumn: d.range.endColumn,
                },
              ],
              edit: {
                edits: action.edits.map((e) => {
                  const r = index.range(e.range.start, e.range.end);
                  return {
                    resource: model.uri,
                    versionId: model.getVersionId(),
                    textEdit: { range: new monaco.Range(r.startLine, r.startColumn, r.endLine, r.endColumn), text: e.text },
                  };
                }),
              },
            };
          });
          return { actions, dispose() {} };
        },
      }),
    );

    onHandle?.({
      insert(value) {
        const selection = editor.getSelection();
        if (!selection) return;
        editor.executeEdits("references", [{ range: selection, text: value, forceMoveMarkers: true }]);
        editor.focus();
      },
      revealLine(line) {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
      },
      applyEdits(edits) {
        const model = editor.getModel();
        if (!model) return;
        editor.executeEdits(
          "fix",
          edits.map((e) => {
            const start = model.getPositionAt(e.start);
            const end = model.getPositionAt(e.end);
            return { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: e.text };
          }),
        );
        editor.focus();
      },
    });
    draw();
    return () => {
      for (const d of disposables) d.dispose();
      decorations.current = null;
      chipDecorations.current = null;
      chipLabels.current = [];
      onHandle?.(null);
    };
  };

  return (
    <CodeEditor
      value={text}
      language={envLanguageId}
      onChange={onChange}
      onReady={onReady}
      onSave={onSave}
      readOnly={readOnly}
      height={height}
      aria-label={t("serviceEnv.editorLabel")}
      options={{
        wordWrap: "off",
        quickSuggestions: false,
        glyphMargin: false,
        folding: false,
        lineDecorationsWidth: 12,
        links: false,
        renderLineHighlight: "none",
      }}
    />
  );
}
