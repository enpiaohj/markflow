import { useEffect, useMemo, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import * as api from "../../lib/api";
import type { XCell, XlsxView, XSheet, XStyle } from "../../lib/types";

const ROW_HEADER_W = 46;
const HEADER_H = 24;
const DEFAULT_ROW_H = 20;

function colName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellCss(style: XStyle | undefined, cell: XCell, showGrid: boolean): React.CSSProperties {
  const css: React.CSSProperties = {
    borderRight: showGrid ? "1px solid #e5e7eb" : "1px solid transparent",
    borderBottom: showGrid ? "1px solid #e5e7eb" : "1px solid transparent",
    padding: "0 4px",
    overflow: "hidden",
    textOverflow: "clip",
    boxSizing: "border-box",
    whiteSpace: "nowrap",
    verticalAlign: "bottom",
    textAlign: cell.num ? "right" : "left",
    color: "#111827",
    fontSize: 14.67,
  };
  if (!style) return css;
  if (style.bold) css.fontWeight = 700;
  if (style.italic) css.fontStyle = "italic";
  if (style.underline) css.textDecoration = "underline";
  if (style.color) css.color = style.color;
  if (style.bg) css.backgroundColor = style.bg;
  if (style.size) css.fontSize = (style.size * 96) / 72;
  if (style.align) css.textAlign = style.align as React.CSSProperties["textAlign"];
  if (style.valign) css.verticalAlign = style.valign === "center" ? "middle" : style.valign;
  if (style.wrap) {
    css.whiteSpace = "pre-wrap";
    css.overflowWrap = "anywhere";
  }
  // 单元格边框：深色实线覆盖网格线
  const line = "1px solid #374151";
  if (style.border & 1) css.borderTop = line;
  if (style.border & 2) css.borderRight = line;
  if (style.border & 4) css.borderBottom = line;
  if (style.border & 8) css.borderLeft = line;
  return css;
}

function SheetGrid({ sheet, styles }: { sheet: XSheet; styles: XStyle[] }) {
  const model = useMemo(() => {
    const cellMap = new Map<number, Map<number, XCell>>();
    const rowH = new Map<number, number>();
    let maxRow = 0;
    for (const row of sheet.rows) {
      const m = new Map<number, XCell>();
      for (const c of row.cells) m.set(c.c, c);
      cellMap.set(row.r, m);
      if (row.h) rowH.set(row.r, row.h);
      maxRow = Math.max(maxRow, row.r + 1);
    }
    // 合并区域：左上角记录跨度，其余被覆盖的单元格不渲染
    const spans = new Map<string, { rs: number; cs: number }>();
    const covered = new Set<string>();
    for (const [r1, c1, r2, c2] of sheet.merges) {
      spans.set(`${r1},${c1}`, { rs: r2 - r1 + 1, cs: c2 - c1 + 1 });
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          if (r !== r1 || c !== c1) covered.add(`${r},${c}`);
        }
      }
      maxRow = Math.max(maxRow, r2 + 1);
    }
    // 冻结行 / 列的粘性偏移
    const rowTops: number[] = [];
    let acc = HEADER_H;
    for (let r = 0; r < sheet.frozenRows; r++) {
      rowTops.push(acc);
      acc += rowH.get(r) ?? DEFAULT_ROW_H;
    }
    const colLefts: number[] = [];
    let accL = ROW_HEADER_W;
    for (let c = 0; c < sheet.frozenCols; c++) {
      colLefts.push(accL);
      accL += sheet.colWidths[c] ?? 64;
    }
    return { cellMap, rowH, maxRow, spans, covered, rowTops, colLefts };
  }, [sheet]);

  const totalW = ROW_HEADER_W + sheet.colWidths.reduce((a, b) => a + b, 0);

  return (
    <table style={{ borderCollapse: "separate", borderSpacing: 0, tableLayout: "fixed", width: totalW }} className="bg-white text-[13px]">
      <colgroup>
        <col style={{ width: ROW_HEADER_W }} />
        {sheet.colWidths.map((w, i) => (
          <col key={i} style={{ width: w }} />
        ))}
      </colgroup>
      <thead>
        <tr style={{ height: HEADER_H }}>
          <th style={{ position: "sticky", top: 0, left: 0, zIndex: 4 }} className="border-b border-r border-gray-300 bg-gray-100" />
          {sheet.colWidths.map((w, i) => (
            <th
              key={i}
              style={{
                position: "sticky",
                top: 0,
                zIndex: i < sheet.frozenCols ? 3 : 2,
                left: i < sheet.frozenCols ? model.colLefts[i] : undefined,
                display: w === 0 ? "none" : undefined,
              }}
              className="border-b border-r border-gray-300 bg-gray-100 text-center text-[11px] font-normal text-gray-500"
            >
              {colName(i)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: model.maxRow }, (_, r) => {
          const rowCells = model.cellMap.get(r);
          const h = model.rowH.get(r) ?? DEFAULT_ROW_H;
          const frozenRow = r < sheet.frozenRows;
          return (
            <tr key={r} style={{ height: h }}>
              <td
                style={{ position: "sticky", left: 0, top: frozenRow ? model.rowTops[r] : undefined, zIndex: frozenRow ? 3 : 1 }}
                className="border-b border-r border-gray-300 bg-gray-100 text-center text-[11px] text-gray-500"
              >
                {r + 1}
              </td>
              {sheet.colWidths.map((w, c) => {
                const key = `${r},${c}`;
                if (model.covered.has(key) || w === 0) return null;
                const cell = rowCells?.get(c);
                const span = model.spans.get(key);
                const style = cell ? styles[cell.s] : undefined;
                const css: React.CSSProperties = cell
                  ? cellCss(style, cell, sheet.showGrid)
                  : { borderRight: sheet.showGrid ? "1px solid #e5e7eb" : "1px solid transparent", borderBottom: sheet.showGrid ? "1px solid #e5e7eb" : "1px solid transparent" };
                const frozenCol = c < sheet.frozenCols;
                if (frozenRow || frozenCol) {
                  css.position = "sticky";
                  if (frozenRow) css.top = model.rowTops[r];
                  if (frozenCol) css.left = model.colLefts[c];
                  css.zIndex = frozenRow && frozenCol ? 3 : 2;
                  if (!css.backgroundColor) css.backgroundColor = "#ffffff";
                }
                return (
                  <td key={c} rowSpan={span?.rs} colSpan={span?.cs} style={css} title={cell && cell.v.length > 24 ? cell.v : undefined}>
                    {cell?.v}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * XLSX 原生表格视图：不转 PDF，直接呈现工作表——列宽、合并单元格、冻结窗格、字体 / 填充 / 边框、
 * 数字与日期格式都与 Excel 一致，打开即显示；底部是 Excel 风格的工作表标签。
 */
export default function XlsxGrid({ libraryId, relativePath, reloadKey }: { libraryId: string; relativePath: string; reloadKey: number }) {
  const [view, setView] = useState<XlsxView | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setError("");
    setActive(0);
    api
      .getXlsxView(libraryId, relativePath)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, relativePath, reloadKey]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6">
        <TriangleAlert className="h-7 w-7 text-amber-400" />
        <p className="mt-3 max-w-md break-all text-center text-sm text-gray-500">{error}</p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-gray-400">
        <Loader2 className="h-6 w-6 animate-spin" />
        <p className="mt-3 text-sm">正在解析工作簿…</p>
      </div>
    );
  }
  const sheet = view.sheets[active];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-white">
        {sheet ? <SheetGrid key={active} sheet={sheet} styles={view.styles} /> : <p className="p-6 text-sm text-gray-400">工作簿没有可显示的工作表</p>}
      </div>
      {sheet?.truncated && (
        <p className="shrink-0 border-t border-amber-200 bg-amber-50 px-4 py-1 text-[11px] text-amber-700">
          仅显示前 2000 行 / 100 列，完整内容请使用系统应用打开（共 {sheet.totalRows.toLocaleString()} 行）。
        </p>
      )}
      {/* Excel 风格的工作表标签栏 */}
      <div className="flex shrink-0 items-end gap-0.5 overflow-x-auto border-t border-gray-300 bg-gray-100 px-2 pt-1">
        {view.sheets.map((s, i) => (
          <button
            key={s.name}
            type="button"
            onClick={() => setActive(i)}
            className={`max-w-[200px] truncate rounded-t-md px-3.5 py-1 text-[12px] ${
              i === active ? "border-x border-t border-gray-300 bg-white font-medium text-emerald-700" : "text-gray-600 hover:bg-gray-200"
            }`}
            title={s.name}
          >
            {s.name}
          </button>
        ))}
      </div>
    </div>
  );
}
