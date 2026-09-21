import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Filter, Loader2, Search, TriangleAlert, X } from "lucide-react";
import * as api from "../../lib/api";
import type { XCell, XlsxView, XSheet, XStyle } from "../../lib/types";

const ROW_HEADER_W = 46;
const HEADER_H = 24;
const DEFAULT_ROW_H = 20;
/** 筛选下拉里最多列出的不同值个数 */
const MAX_FILTER_VALUES = 800;
const BLANK = "（空白）";

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

// ---------------------------------------------------------------------------
// 列筛选下拉（与 Excel 自动筛选类似：搜索 + 值列表 + 全选 / 清除）
// ---------------------------------------------------------------------------

function ColumnFilterPopover({
  anchor,
  title,
  values,
  selected,
  onChange,
  onClose,
}: {
  anchor: { x: number; y: number };
  title: string;
  /** 该列所有不同的值及出现次数 */
  values: { value: string; count: number }[];
  /** 当前允许显示的值；null 表示不筛选（全部） */
  selected: Set<string> | null;
  onChange: (next: Set<string> | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const shown = q ? values.filter((v) => v.value.toLowerCase().includes(q)) : values;
  const isOn = (v: string) => (selected === null ? true : selected.has(v));
  const allValues = () => new Set(values.map((v) => v.value));

  function toggle(v: string) {
    const next = selected === null ? allValues() : new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange(next.size === values.length ? null : next);
  }
  /** 只对当前搜索结果全选 / 清除（与 Excel 一致：搜索后「全选」= 选中匹配项） */
  function setShown(on: boolean) {
    if (!q) {
      onChange(on ? null : new Set());
      return;
    }
    const base = selected === null ? allValues() : new Set(selected);
    for (const v of shown) (on ? base.add(v.value) : base.delete(v.value));
    onChange(base.size === values.length ? null : base);
  }

  // 视口内定位
  const left = Math.min(anchor.x, window.innerWidth - 260);
  const top = Math.min(anchor.y, window.innerHeight - 380);

  return (
    <div
      ref={boxRef}
      className="fixed z-50 w-60 rounded-lg border border-gray-200 bg-white text-[13px] shadow-xl"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
    >
      <div className="border-b border-gray-100 px-3 py-2 text-xs font-medium text-gray-600">筛选：{title}</div>
      <div className="px-2.5 pt-2">
        <div className="flex h-7 items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索"
            className="w-full bg-transparent text-xs outline-none placeholder:text-gray-400"
          />
        </div>
        <div className="mt-1.5 flex items-center gap-3 text-[11px]">
          <button type="button" onClick={() => setShown(true)} className="text-primary-600 hover:underline">
            全选
          </button>
          <button type="button" onClick={() => setShown(false)} className="text-primary-600 hover:underline">
            清除
          </button>
          <span className="ml-auto text-gray-400">
            {selected === null ? `全部 ${values.length}` : `已选 ${selected.size} / ${values.length}`}
          </span>
        </div>
      </div>
      <div className="mt-1 max-h-60 overflow-y-auto px-1.5 pb-1">
        {shown.length === 0 && <p className="px-2 py-3 text-center text-xs text-gray-400">没有匹配的值</p>}
        {shown.map((v) => (
          <label key={v.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-gray-50">
            <input type="checkbox" checked={isOn(v.value)} onChange={() => toggle(v.value)} className="accent-primary-600" />
            <span className="min-w-0 flex-1 truncate" title={v.value}>
              {v.value === "" ? BLANK : v.value}
            </span>
            <span className="shrink-0 text-[11px] text-gray-400">{v.count}</span>
          </label>
        ))}
        {values.length >= MAX_FILTER_VALUES && (
          <p className="px-2 py-1 text-[10px] text-gray-400">不同的值过多，仅列出前 {MAX_FILTER_VALUES} 个（可用搜索缩小范围）</p>
        )}
      </div>
      <div className="flex justify-between border-t border-gray-100 px-3 py-2">
        <button type="button" onClick={() => onChange(null)} className="text-xs text-gray-500 hover:text-primary-600">
          清除此列筛选
        </button>
        <button type="button" onClick={onClose} className="rounded-md bg-primary-600 px-3 py-0.5 text-xs text-white hover:bg-primary-700">
          完成
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 单个工作表
// ---------------------------------------------------------------------------

/** 默认表头行：优先文件里的自动筛选范围，其次冻结窗格的最后一行，否则第一行至少有 2 个非空单元格的行 */
function guessHeaderRow(sheet: XSheet): number {
  if (sheet.autoFilter) return sheet.autoFilter[0];
  if (sheet.frozenRows > 0) return sheet.frozenRows - 1;
  const row = sheet.rows.find((r) => r.cells.filter((c) => c.v !== "").length >= 2);
  return row ? row.r : 0;
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

  // ---- 筛选状态 ----
  const [filterOn, setFilterOn] = useState(!!sheet.autoFilter); // 文件里本来就有自动筛选时默认开启
  const [headerRow, setHeaderRow] = useState(() => guessHeaderRow(sheet));
  const [filters, setFilters] = useState<Record<number, Set<string> | null>>({});
  const [popover, setPopover] = useState<{ col: number; x: number; y: number } | null>(null);

  const lastDataRow = sheet.autoFilter ? Math.min(sheet.autoFilter[2], model.maxRow - 1) : model.maxRow - 1;
  const cellText = (r: number, c: number) => model.cellMap.get(r)?.get(c)?.v ?? "";

  const activeCols = Object.entries(filters).filter(([, v]) => v !== null).map(([c]) => Number(c));
  const filterActive = filterOn && activeCols.length > 0;

  // 每列的不同值（限定在表头行之后的数据行）
  const columnValues = useMemo(() => {
    const out = new Map<number, { value: string; count: number }[]>();
    if (!filterOn) return out;
    for (let c = 0; c < sheet.colCount; c++) {
      const counts = new Map<string, number>();
      for (let r = headerRow + 1; r <= lastDataRow; r++) {
        const v = model.cellMap.get(r)?.get(c)?.v ?? "";
        counts.set(v, (counts.get(v) ?? 0) + 1);
        if (counts.size >= MAX_FILTER_VALUES) break;
      }
      const list = [...counts.entries()].map(([value, count]) => ({ value, count }));
      const numeric = list.every((x) => x.value === "" || !Number.isNaN(Number(x.value.replace(/[,%¥$\s]/g, ""))));
      list.sort((a, b) => {
        if (a.value === "") return 1;
        if (b.value === "") return -1;
        return numeric
          ? Number(a.value.replace(/[,%¥$\s]/g, "")) - Number(b.value.replace(/[,%¥$\s]/g, ""))
          : a.value.localeCompare(b.value, "zh-Hans-CN");
      });
      out.set(c, list);
    }
    return out;
  }, [filterOn, headerRow, lastDataRow, sheet.colCount, model.cellMap]);

  // 被筛掉的行
  const hiddenRows = useMemo(() => {
    const hidden = new Set<number>();
    if (!filterOn) return hidden;
    for (let r = headerRow + 1; r <= lastDataRow; r++) {
      for (const [c, allowed] of Object.entries(filters)) {
        if (allowed && !allowed.has(model.cellMap.get(r)?.get(Number(c))?.v ?? "")) {
          hidden.add(r);
          break;
        }
      }
    }
    return hidden;
  }, [filterOn, filters, headerRow, lastDataRow, model.cellMap]);

  const dataRowCount = Math.max(0, lastDataRow - headerRow);
  const totalW = ROW_HEADER_W + sheet.colWidths.reduce((a, b) => a + b, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 筛选工具条 */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 text-xs text-gray-600">
        <button
          type="button"
          onClick={() => {
            setFilterOn((v) => !v);
            setPopover(null);
          }}
          className={`flex h-6 items-center gap-1.5 rounded-md border px-2 ${
            filterOn ? "border-primary-200 bg-primary-50 text-primary-700" : "border-gray-200 bg-white hover:bg-gray-100"
          }`}
          title="按值筛选（表头行出现筛选按钮）"
        >
          <Filter className="h-3.5 w-3.5" />
          筛选
        </button>
        {filterOn && (
          <>
            <label className="flex items-center gap-1 text-gray-500">
              表头行
              <select
                value={headerRow}
                onChange={(e) => {
                  setHeaderRow(Number(e.target.value));
                  setFilters({});
                  setPopover(null);
                }}
                className="h-6 rounded-md border border-gray-200 bg-white px-1 text-xs"
              >
                {Array.from({ length: Math.min(model.maxRow, 20) }, (_, i) => (
                  <option key={i} value={i}>
                    第 {i + 1} 行
                  </option>
                ))}
              </select>
            </label>
            <span className="text-gray-400">
              显示 {(dataRowCount - hiddenRows.size).toLocaleString()} / {dataRowCount.toLocaleString()} 行
            </span>
            {filterActive && (
              <button
                type="button"
                onClick={() => setFilters({})}
                className="flex h-6 items-center gap-1 rounded-md border border-gray-200 bg-white px-2 hover:bg-gray-100"
              >
                <X className="h-3 w-3" />
                清除全部筛选
              </button>
            )}
          </>
        )}
        <span className="ml-auto text-[11px] text-gray-400">
          {sheet.autoFilter ? "文件包含自动筛选范围" : filterOn ? "只影响显示，不修改文件" : ""}
        </span>
      </div>

      <div className="mf-light min-h-0 flex-1 overflow-auto bg-white">
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
              if (hiddenRows.has(r)) return null;
              const rowCells = model.cellMap.get(r);
              const h = model.rowH.get(r) ?? DEFAULT_ROW_H;
              const frozenRow = r < sheet.frozenRows;
              const isHeader = filterOn && r === headerRow;
              const inData = filterOn && r > headerRow && r <= lastDataRow;
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
                    // 筛选生效时数据区不做合并单元格跨行处理（被隐藏的行会让跨度失真）
                    const ignoreMerge = filterActive && inData;
                    if ((!ignoreMerge && model.covered.has(key)) || w === 0) return null;
                    const cell = rowCells?.get(c);
                    const span = ignoreMerge ? undefined : model.spans.get(key);
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
                    } else if (isHeader) {
                      css.position = "relative";
                    }
                    const active = filters[c] != null;
                    return (
                      <td key={c} rowSpan={span?.rs} colSpan={span?.cs} style={css} title={cell && cell.v.length > 24 ? cell.v : undefined}>
                        {cell?.v}
                        {isHeader && c < sheet.colCount && (
                          <button
                            type="button"
                            title={active ? "已筛选（点击修改）" : "筛选"}
                            onClick={(e) => {
                              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              setPopover({ col: c, x: rect.left, y: rect.bottom + 2 });
                            }}
                            className={`absolute right-0 top-0 flex h-full w-[18px] items-center justify-center border-l ${
                              active ? "border-primary-300 bg-primary-100 text-primary-700" : "border-gray-300 bg-white/90 text-gray-500 hover:bg-gray-100"
                            }`}
                            style={{ fontWeight: 400 }}
                          >
                            {active ? <Filter className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {popover && (
        <ColumnFilterPopover
          anchor={{ x: popover.x, y: popover.y }}
          title={cellText(headerRow, popover.col) || `列 ${colName(popover.col)}`}
          values={columnValues.get(popover.col) ?? []}
          selected={filters[popover.col] ?? null}
          onChange={(next) => setFilters((f) => ({ ...f, [popover.col]: next }))}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  );
}

/**
 * XLSX 原生表格视图：不转 PDF，直接呈现工作表——列宽、合并单元格、冻结窗格、字体 / 填充 / 边框、
 * 数字与日期格式都与 Excel 一致，打开即显示；底部是 Excel 风格的工作表标签，
 * 顶部可开启按值筛选（只影响显示，不修改文件）。
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
      <div className="min-h-0 flex-1">
        {sheet ? <SheetGrid key={`${reloadKey}-${active}`} sheet={sheet} styles={view.styles} /> : <p className="p-6 text-sm text-gray-400">工作簿没有可显示的工作表</p>}
      </div>
      {sheet?.truncated && (
        <p className="shrink-0 border-t border-amber-200 bg-amber-50 px-4 py-1 text-[11px] text-amber-700">
          仅显示前 2000 行 / 100 列，完整内容请使用系统应用打开（共 {sheet.totalRows.toLocaleString()} 行）；筛选只作用于已显示的部分。
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
