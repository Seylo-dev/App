// A Monaco editor as a React component. Monaco loads on first use (its own
// chunk); until then a quiet placeholder keeps the layout. The component
// is uncontrolled after mount: value seeds the model, onChange reports
// edits, and setValue through the handle replaces the text (for reloads).

import { Skeleton } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import type * as MonacoApi from "monaco-editor/editor/editor.api";
import { useEffect, useRef, useState } from "react";
import { EchoTracker } from "./echo";
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

/** Resolves in the browser's next idle moment, or after `timeout` ms. */
function afterIdle(timeout: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout });
    else setTimeout(resolve, Math.min(timeout, 50));
  });
}

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
  // Texts reported through onChange, so an older one coming back as value is not taken for a reload.
  const echoes = useRef(new EchoTracker());

  // Mount once per language; later value changes from outside go through the effect below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value, onReady and options seed the editor only on mount.
  useEffect(() => {
    let disposed = false;
    let cleanup: undefined | (() => void);
    let editor: CodeEditorInstance | null = null;
    loadMonaco()
      .then(async (loaded) => {
        // Creating an editor takes a long frame: let the page finish easing in first (idle, or 250 ms at most).
        await afterIdle(250);
        return loaded;
      })
      .then(
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
          editor.onDidChangeModelContent(() => {
            const text = editor?.getValue() ?? "";
            echoes.current.emitted(text);
            latest.current.onChange?.(text);
          });
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

  // Replace the text when the parent hands in a different value (a reload), keeping undo. A
  // value the editor reported itself is an echo of typing, maybe an old one (echo.ts): replacing
  // the text with it would drop the keys typed since.
  useEffect(() => {
    const editor = editorRef.current;
    const echo = echoes.current.isEcho(value);
    if (!editor || echo || editor.getValue() === value) return;
    const model = editor.getModel();
    if (!model) return;
    // The edit reports the reload through onDidChangeModelContent: that is no echo (echo.ts).
    echoes.current.reload(() => editor.executeEdits("reload", [{ range: model.getFullModelRange(), text: value }]));
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
