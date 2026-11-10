// A Monaco editor as a React component. Monaco loads on first use (its own
// chunk); until then a quiet placeholder keeps the layout. The component
// is uncontrolled after mount: value seeds the model, onChange reports
// edits, and setValue through the handle replaces the text (for reloads).

import { Skeleton } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import type * as MonacoApi from "monaco-editor/editor/editor.api";
import { useEffect, useRef, useState } from "react";
import type { Monaco } from "./monaco";
import { pickTheme } from "./theme";

export type CodeEditorInstance = MonacoApi.editor.IStandaloneCodeEditor;

export interface CodeEditorProps {
  value: string;
  language: string;
  onChange?: (value: string) => void;
  /** Called once Monaco and the editor exist; return a cleanup for providers you registered. */
  onReady?: (editor: CodeEditorInstance, monaco: Monaco) => undefined | (() => void);
  /** Cmd/Ctrl+S. */
  onSave?: () => void;
  readOnly?: boolean;
  height?: number | string;
  "aria-label": string;
  className?: string;
  /** Extra Monaco options. */
  options?: MonacoApi.editor.IStandaloneEditorConstructionOptions;
}

import { loadMonaco } from "./load-monaco";

export { loadMonaco };

export function CodeEditor({
  value,
  language,
  onChange,
  onReady,
  onSave,
  readOnly = false,
  height = 360,
  className,
  options,
  ...rest
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const latest = useRef({ onChange, onSave });
  latest.current = { onChange, onSave };
  const editorRef = useRef<CodeEditorInstance | null>(null);

  // Mount once per language; later value changes from outside go through the effect below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value, onReady and options seed the editor only on mount.
  useEffect(() => {
    let disposed = false;
    let cleanup: undefined | (() => void);
    let editor: CodeEditorInstance | null = null;
    loadMonaco().then(
      ({ monaco }) => {
        if (disposed || !host.current) return;
        editor = monaco.editor.create(host.current, {
          value,
          language,
          theme: pickTheme(),
          readOnly,
          automaticLayout: true,
          minimap: { enabled: false },
          fontFamily: "'Geist Mono Variable', 'Geist Mono', ui-monospace, monospace",
          fontSize: 13,
          lineHeight: 26,
          lineNumbersMinChars: 3,
          padding: { top: 12, bottom: 18 },
          scrollBeyondLastLine: false,
          renderLineHighlight: "line",
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
          fixedOverflowWidgets: true,
          tabSize: 2,
          ariaLabel: rest["aria-label"],
          ...options,
        });
        editorRef.current = editor;
        editor.onDidChangeModelContent(() => latest.current.onChange?.(editor?.getValue() ?? ""));
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => latest.current.onSave?.());
        cleanup = onReady?.(editor, monaco);
        setReady(true);
      },
      () => !disposed && setFailed(true),
    );
    return () => {
      disposed = true;
      cleanup?.();
      editor?.getModel()?.dispose();
      editor?.dispose();
      editorRef.current = null;
    };
  }, [language]);

  // Replace the text when the parent hands in a different value (a reload), keeping undo.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.getValue() === value) return;
    const model = editor.getModel();
    if (!model) return;
    editor.executeEdits("reload", [{ range: model.getFullModelRange(), text: value }]);
  }, [value]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return (
    <div className={cn("relative min-w-0", className)} style={{ height }}>
      <div ref={host} className="absolute inset-0" />
      {!ready && !failed && <Skeleton className="absolute inset-3 rounded-control" />}
      {failed && (
        <textarea
          aria-label={rest["aria-label"]}
          className="absolute inset-0 resize-none border-0 bg-transparent p-3 font-mono text-[13px] outline-none"
          defaultValue={value}
          readOnly={readOnly}
          onChange={(e) => onChange?.(e.target.value)}
        />
      )}
    </div>
  );
}
