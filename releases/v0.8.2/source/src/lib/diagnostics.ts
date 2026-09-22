import type { ValidatorKind } from "./codeLanguages";

/**
 * 诊断适配器：把「某种语言的语法校验」抽象成统一接口，编辑器只依赖它，
 * 不关心具体实现（后续可接入 LSP / 外部校验器而不改编辑器组件）。
 */
export interface Issue {
  /** 文档内的字符偏移（[from, to)） */
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
}

export interface Validator {
  kind: ValidatorKind;
  validate(text: string): Issue[] | Promise<Issue[]>;
}

/** 行 / 列（1 起）→ 偏移；越界时夹到文本末尾。 */
export function offsetOf(text: string, line: number, col: number): number {
  let idx = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf("\n", idx);
    if (nl < 0) return text.length;
    idx = nl + 1;
  }
  return Math.min(text.length, idx + Math.max(0, col - 1));
}

/** 偏移 → 行 / 列（1 起）。 */
export function lineColOf(text: string, offset: number): { line: number; col: number } {
  const upto = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const line = upto.split("\n").length;
  const col = offset - (upto.lastIndexOf("\n") + 1) + 1;
  return { line, col };
}

/** 令 [from,to) 至少覆盖一个字符（便于下划线可见）。 */
function span(text: string, from: number, to?: number): { from: number; to: number } {
  const f = Math.max(0, Math.min(from, text.length));
  let t = Math.max(to ?? f + 1, f + 1);
  if (t > text.length) t = text.length;
  return { from: Math.min(f, Math.max(0, t - 1)), to: Math.max(t, Math.min(f + 1, text.length)) };
}

class JsonFail extends Error {
  constructor(
    public pos: number,
    msg: string,
  ) {
    super(msg);
  }
}

const NL = "\n";
const BACKSLASH = "\\";
const SIMPLE_ESCAPES = '"\\/bfnrt';

/**
 * 精确的 JSON 语法检查（递归下降）：直接给出出错位置，不依赖各引擎 `JSON.parse` 错误文案
 * （新版 V8 的报错不再带位置）。`tolerant` 为 JSONC：允许注释与尾逗号。
 */
function jsonSyntaxError(text: string, tolerant: boolean): { pos: number; msg: string } | null {
  let i = 0;
  const n = text.length;
  const show = (c: string | undefined) => (c === undefined ? "文件结尾" : `「${c}」`);

  const ws = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (tolerant && text[i] === "/" && text[i + 1] === "/") {
        while (i < n && text[i] !== NL) i++;
      } else if (tolerant && text[i] === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) throw new JsonFail(i, "注释未闭合");
        i = end + 2;
      } else return;
    }
  };

  const str = () => {
    const start = i;
    i++; // 开头的引号
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        i++;
        return;
      }
      if (c === NL) throw new JsonFail(start, "字符串没有闭合（不允许直接换行）");
      if (c === BACKSLASH) {
        const e = text[i + 1];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) throw new JsonFail(i, "无效的 Unicode 转义（需要 4 位十六进制）");
          i += 6;
          continue;
        }
        if (e === undefined || !SIMPLE_ESCAPES.includes(e)) throw new JsonFail(i, `无效的转义序列「${BACKSLASH}${e ?? ""}」`);
        i += 2;
        continue;
      }
      i++;
    }
    throw new JsonFail(start, "字符串没有闭合");
  };

  const value = (): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      ws();
      if (text[i] === "}") return void i++;
      for (;;) {
        ws();
        if (tolerant && text[i] === "}") return void i++; // 尾逗号
        if (text[i] !== '"') throw new JsonFail(i, `期望属性名（双引号字符串），遇到${show(text[i])}`);
        str();
        ws();
        if (text[i] !== ":") throw new JsonFail(i, `期望「:」，遇到${show(text[i])}`);
        i++;
        value();
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") return void i++;
        throw new JsonFail(i, `期望「,」或「}」，遇到${show(text[i])}`);
      }
    } else if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") return void i++;
      for (;;) {
        ws();
        if (tolerant && text[i] === "]") return void i++;
        value();
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") return void i++;
        throw new JsonFail(i, `期望「,」或「]」，遇到${show(text[i])}`);
      }
    } else if (c === '"') {
      str();
    } else if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
      const m = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
      m.lastIndex = i;
      const r = m.exec(text);
      if (!r) throw new JsonFail(i, "无效的数字");
      i += r[0].length;
    } else {
      const lit = ["true", "false", "null"].find((l) => text.startsWith(l, i));
      if (!lit) throw new JsonFail(i, `意外的${show(c)}`);
      i += lit.length;
    }
  };

  try {
    value();
    ws();
    if (i < n) throw new JsonFail(i, `值之后有多余内容：${show(text[i])}`);
    return null;
  } catch (e) {
    if (e instanceof JsonFail) return { pos: e.pos, msg: e.message };
    throw e;
  }
}

function jsonIssues(text: string, tolerant: boolean): Issue[] {
  if (text.trim() === "") return [];
  const err = jsonSyntaxError(text, tolerant);
  if (!err) return [];
  const { from, to } = span(text, err.pos);
  const { line, col } = lineColOf(text, err.pos);
  return [{ from, to, severity: "error", message: `JSON 语法错误（第 ${line} 行，第 ${col} 列）：${err.msg}` }];
}

async function yamlIssues(text: string): Promise<Issue[]> {
  if (text.trim() === "") return [];
  const { parseAllDocuments } = await import("yaml");
  const out: Issue[] = [];
  for (const doc of parseAllDocuments(text)) {
    for (const err of doc.errors) {
      const [start, end] = err.pos;
      const { from, to } = span(text, start, end);
      const { line, col } = lineColOf(text, start);
      out.push({ from, to, severity: "error", message: `YAML 语法错误（第 ${line} 行，第 ${col} 列）：${err.message.split(NL)[0]}` });
    }
    for (const w of doc.warnings) {
      const [start, end] = w.pos;
      const { from, to } = span(text, start, end);
      out.push({ from, to, severity: "warning", message: `YAML 提示：${w.message.split(NL)[0]}` });
    }
  }
  return out;
}

function xmlIssues(text: string): Issue[] {
  if (text.trim() === "") return [];
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const err = doc.querySelector("parsererror");
  if (!err) return [];
  const raw = (err.textContent ?? "").trim();
  const m = /error on line (\d+) at column (\d+):\s*([^\n]*)/i.exec(raw);
  const line = m ? Number(m[1]) : 1;
  const col = m ? Number(m[2]) : 1;
  const pos = offsetOf(text, line, col);
  const { from, to } = span(text, pos);
  const detail = (m?.[3] ?? raw.split(NL)[0]).trim();
  return [{ from, to, severity: "error", message: `XML 语法错误（第 ${line} 行，第 ${col} 列）：${detail}` }];
}

const VALIDATORS: Record<ValidatorKind, Validator> = {
  json: { kind: "json", validate: (t) => jsonIssues(t, false) },
  jsonc: { kind: "jsonc", validate: (t) => jsonIssues(t, true) },
  yaml: { kind: "yaml", validate: yamlIssues },
  xml: { kind: "xml", validate: xmlIssues },
};

export function getValidator(kind: ValidatorKind | undefined): Validator | null {
  return kind ? VALIDATORS[kind] : null;
}

/** 统一入口：对文档做语法校验，返回带位置的问题列表。 */
export async function validateDocument(kind: ValidatorKind | undefined, text: string): Promise<Issue[]> {
  const v = getValidator(kind);
  if (!v) return [];
  try {
    return await v.validate(text);
  } catch {
    return []; // 校验器自身异常不应影响编辑
  }
}
