// The custom CSS editor (Monaco, CSS highlighting, dark like the board's
// card). Monaco loads on first use; until then a skeleton keeps the space.
// The card's "Insert example" button adds text through the handle (insert),
// as one edit that Undo takes back.

import { Skeleton } from "@seylo/ui/components/skeleton";
import type * as MonacoApi from "monaco-editor/editor/editor.api";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";

let loading: Promise<typeof import("./monaco-css")> | null = null;

function loadCssMonaco() {
  loading ??= import("./monaco-css");
  return loading;
}

export interface CssEditorHandle {
  /** Adds text after what is there (a blank line between), shows it and puts the cursor at its end. */
  insert: (text: string) => void;
}

/** The editor's text with `text` added at the end, a blank line apart. */
export function appendCss(current: string, text: string): string {
  const trimmed = current.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${text}` : text;
}

export function CssEditor({
  value,
  onChange,
  readOnly,
  height = 320,
  "aria-label": label,
  ref,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
  height?: number;
  "aria-label": string;
  ref?: Ref<CssEditorHandle>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useImperativeHandle(ref, () => ({
    insert(text) {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!editor || !model) {
        changeRef.current(appendCss(valueRef.current, text));
        return;
      }
      const next = appendCss(model.getValue(), text);
      const full = model.getFullModelRange();
      editor.pushUndoStop();
      editor.executeEdits("insert-example", [{ range: full, text: next }]);
      editor.pushUndoStop();
      const end = model.getFullModelRange().getEndPosition();
      editor.setPosition(end);
      editor.revealLine(end.lineNumber);
      editor.focus();
    },
  }));

  // biome-ignore lint/correctness/useExhaustiveDependencies: value and readOnly seed the editor on mount; later changes go through the effects below.
  useEffect(() => {
    let disposed = false;
    loadCssMonaco().then(
      ({ monaco, defineCssTheme }) => {
        if (disposed || !host.current) return;
        const editor = monaco.editor.create(host.current, {
          value,
          language: "css",
          theme: defineCssTheme(),
          readOnly,
          automaticLayout: true,
          minimap: { enabled: false },
          fontFamily: "'Geist Mono Variable', 'Geist Mono', ui-monospace, monospace",
          fontSize: 12.5,
          lineHeight: 22,
          lineNumbersMinChars: 3,
          padding: { top: 12, bottom: 16 },
          scrollBeyondLastLine: false,
          // No overview ruler or scrollbar track while the CSS fits, as in the service editor.
          overviewRulerLanes: 0,
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
          tabSize: 2,
          ariaLabel: label,
        });
        editor.onDidChangeModelContent(() => changeRef.current(editor.getValue()));
        editorRef.current = editor;
        setReady(true);
      },
      () => setFailed(true),
    );
    return () => {
      disposed = true;
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  // Text replaced from outside (after a save or a reset) without fighting the cursor while typing.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value]);

  if (failed) {
    return (
      <textarea
        aria-label={label}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        style={{ height }}
        className="w-full resize-y border-0 bg-terminal p-3 font-mono text-[12.5px] text-terminal-foreground outline-none"
      />
    );
  }
  return (
    <div className="relative" style={{ height }}>
      {!ready && <Skeleton className="absolute inset-3 bg-terminal-bar" />}
      <div ref={host} className="size-full" data-monaco-theme="custom-css" />
    </div>
  );
}
