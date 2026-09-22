import { useEffect, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from "@codemirror/view";
import { basicSetup } from "codemirror";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { forceLinting, linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { indentUnit } from "@codemirror/language";
import type { CodeLanguage } from "../../lib/codeLanguages";
import { validateDocument, lineColOf, type Issue } from "../../lib/diagnostics";
import { useZoom } from "../ZoomContext";

/** 编辑器对外暴露的少量命令（问题面板跳转、聚焦等），不泄露 CodeMirror 实例。 */
export interface CodeEditorApi {
  gotoOffset: (offset: number) => void;
  focus: () => void;
}

export interface CodeIssue extends Issue {
  line: number;
  col: number;
}

interface Props {
  initial: string;
  language: CodeLanguage;
  wrap: boolean;
  readOnly: boolean;
  /** 保护模式（大文件）：关闭语法高亮、折叠、括号联动、诊断，保证输入流畅 */
  largeMode: boolean;
  indent: { kind: "tab" | "space"; width: number };
  onChange: (text: string) => void;
  onCursor: (line: number, col: number) => void;
  onIssues: (issues: CodeIssue[]) => void;
  registerSelection: (fn: () => string) => void;
  registerApi: (api: CodeEditorApi) => void;
}

/** 编辑器基础扩展：完整模式用 basicSetup，保护模式用轻量集合。 */
function baseExtensions(largeMode: boolean): Extension {
  if (!largeMode) return [basicSetup, keymap.of([indentWithTab])];
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
  ];
}

/** 诊断扩展：校验器由当前语言决定（见 lib/diagnostics.ts），结果同时回传给问题面板。 */
function lintExtensions(get: () => Props): Extension {
  return [
    linter(
      async (view): Promise<Diagnostic[]> => {
        const { language, largeMode, onIssues } = get();
        if (largeMode || !language.validator) {
          onIssues([]);
          return [];
        }
        const text = view.state.doc.toString();
        const issues = await validateDocument(language.validator, text);
        onIssues(issues.map((i) => ({ ...i, ...lineColOf(text, i.from) })));
        return issues.map((i) => ({ from: i.from, to: i.to, severity: i.severity, message: i.message }));
      },
      { delay: 400 },
    ),
    lintGutter(),
  ];
}

function indentExtensions(indent: { kind: "tab" | "space"; width: number }): Extension {
  return [indentUnit.of(indent.kind === "tab" ? "\t" : " ".repeat(indent.width)), EditorState.tabSize.of(indent.width)];
}

/**
 * 统一的 CodeMirror 6 代码编辑器：所有文件类型共用同一套扩展工厂，
 * 语言、换行、只读通过 Compartment 动态切换，无需重建编辑器（不丢光标与撤销栈）。
 */
export default function CodeEditor(props: Props) {
  const { language, wrap, readOnly, largeMode } = props;
  const { config: zoomConfig } = useZoom();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langC = useRef(new Compartment());
  const wrapC = useRef(new Compartment());
  const roC = useRef(new Compartment());
  const lintC = useRef(new Compartment());
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    if (!hostRef.current) return;
    const p = propsRef.current;
    const view = new EditorView({
      state: EditorState.create({
        doc: p.initial,
        extensions: [
          baseExtensions(p.largeMode),
          indentExtensions(p.indent),
          langC.current.of([]),
          wrapC.current.of(p.wrap ? EditorView.lineWrapping : []),
          roC.current.of(p.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
          lintC.current.of(p.largeMode ? [] : lintExtensions(() => propsRef.current)),
          // 编辑器撑满容器，由内部 scroller 出滚动条（否则长文本被外层 overflow-hidden 截断）
          EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } }),
          EditorView.updateListener.of((update: ViewUpdate) => {
            if (update.docChanged) propsRef.current.onChange(update.state.doc.toString());
            if (update.docChanged || update.selectionSet) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              propsRef.current.onCursor(line.number, head - line.from + 1);
            }
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    p.registerSelection(() => {
      const sel = view.state.selection.main;
      return view.state.sliceDoc(sel.from, sel.to);
    });
    p.registerApi({
      gotoOffset: (offset) => {
        const pos = Math.max(0, Math.min(offset, view.state.doc.length));
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        view.focus();
      },
      focus: () => view.focus(),
    });
    p.onCursor(1, 1);
    return () => view.destroy();
    // initial 仅在挂载时使用；编辑中的变化通过 onChange 上抛，切换编辑器由 key 重建完成
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 语言：异步加载语法包后再套用（加载期间保持无高亮，不阻塞输入）
  useEffect(() => {
    let cancelled = false;
    if (largeMode) {
      viewRef.current?.dispatch({ effects: langC.current.reconfigure([]) });
      return;
    }
    void language
      .load()
      .then((ext) => {
        if (!cancelled) viewRef.current?.dispatch({ effects: langC.current.reconfigure(ext ?? []) });
      })
      .catch(() => {
        /* 语言包加载失败时降级为纯文本 */
      });
    return () => {
      cancelled = true;
    };
  }, [language, largeMode]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapC.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: roC.current.reconfigure(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    });
  }, [readOnly]);

  // 换语言后立即重新校验
  useEffect(() => {
    if (viewRef.current && !largeMode) forceLinting(viewRef.current);
  }, [language.id, largeMode]);

  return <div ref={hostRef} className="h-full overflow-hidden bg-white" style={{ zoom: zoomConfig.value }} />;
}
