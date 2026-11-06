// The custom CSS editor (Monaco, CSS highlighting, dark like the board's
// card). Monaco loads on first use; until then a skeleton keeps the space.

import { Skeleton } from "@seylo/ui/components/skeleton";
import type * as MonacoApi from "monaco-editor/editor/editor.api";
import { useEffect, useRef, useState } from "react";

let loading: Promise<typeof import("./monaco-css")> | null = null;

function loadCssMonaco() {
  loading ??= import("./monaco-css");
  return loading;
}

export function CssEditor({
  value,
  onChange,
  readOnly,
  height = 320,
  "aria-label": label,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
  height?: number;
  "aria-label": string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

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
