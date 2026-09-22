import type { Extension } from "@codemirror/state";

/**
 * 代码语言注册表：唯一的「文件 → 语言」判定与语言包加载入口。
 * 语言包全部动态加载（首次打开该语言时才下载 / 解析），不拖慢应用启动。
 * 识别顺序：文件名 → 扩展名 → Shebang → 纯文本降级；用户可在状态栏手动覆盖。
 */

/** 诊断适配器种类（见 lib/diagnostics.ts） */
export type ValidatorKind = "json" | "jsonc" | "yaml" | "xml";

export interface CodeLanguage {
  id: string;
  label: string;
  /** 扩展名（小写、不带点） */
  exts: string[];
  /** 整个文件名（小写），如 dockerfile */
  names?: string[];
  /** Shebang 解释器关键字，如 python / node / bash / pwsh */
  interpreters?: string[];
  validator?: ValidatorKind;
  /** 该语言的行注释 / 缩进等由语言包自带；返回 null 表示无语法高亮（纯文本） */
  load: () => Promise<Extension | null>;
}

async function legacy(mod: Promise<Record<string, unknown>>, key: string): Promise<Extension> {
  const [{ StreamLanguage }, m] = await Promise.all([import("@codemirror/language"), mod]);
  return StreamLanguage.define(m[key] as Parameters<typeof StreamLanguage.define>[0]);
}

export const LANGUAGES: CodeLanguage[] = [
  { id: "text", label: "纯文本", exts: ["txt", "text", "log", "csv"], load: async () => null },
  { id: "markdown", label: "Markdown", exts: ["md", "markdown", "mdx"], load: async () => (await import("@codemirror/lang-markdown")).markdown() },
  {
    id: "javascript",
    label: "JavaScript",
    exts: ["js", "jsx", "mjs", "cjs"],
    interpreters: ["node", "deno", "bun"],
    load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  },
  {
    id: "typescript",
    label: "TypeScript",
    exts: ["ts", "tsx", "mts", "cts"],
    load: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }),
  },
  { id: "python", label: "Python", exts: ["py", "pyw", "pyi"], interpreters: ["python", "python3"], load: async () => (await import("@codemirror/lang-python")).python() },
  { id: "html", label: "HTML", exts: ["html", "htm", "vue", "svelte"], load: async () => (await import("@codemirror/lang-html")).html() },
  { id: "css", label: "CSS", exts: ["css", "scss", "less"], load: async () => (await import("@codemirror/lang-css")).css() },
  { id: "sql", label: "SQL", exts: ["sql"], load: async () => (await import("@codemirror/lang-sql")).sql() },
  { id: "json", label: "JSON", exts: ["json"], validator: "json", load: async () => (await import("@codemirror/lang-json")).json() },
  {
    id: "jsonc",
    label: "JSON（含注释）",
    exts: ["jsonc", "json5"],
    names: [".eslintrc", ".prettierrc"],
    validator: "jsonc",
    load: async () => (await import("@codemirror/lang-json")).json(),
  },
  { id: "yaml", label: "YAML", exts: ["yaml", "yml"], validator: "yaml", load: async () => (await import("@codemirror/lang-yaml")).yaml() },
  { id: "xml", label: "XML", exts: ["xml", "xaml", "csproj", "props", "targets", "svg", "config", "xsd", "xsl", "xslt", "plist"], validator: "xml", load: async () => (await import("@codemirror/lang-xml")).xml() },
  {
    id: "powershell",
    label: "PowerShell",
    exts: ["ps1", "psm1", "psd1"],
    interpreters: ["pwsh", "powershell"],
    load: () => legacy(import("@codemirror/legacy-modes/mode/powershell"), "powerShell"),
  },
  { id: "csharp", label: "C#", exts: ["cs", "csx"], load: () => legacy(import("@codemirror/legacy-modes/mode/clike"), "csharp") },
  {
    id: "shell",
    label: "Shell",
    exts: ["sh", "bash", "zsh"],
    names: [".bashrc", ".zshrc", ".profile"],
    interpreters: ["bash", "sh", "zsh", "dash"],
    load: () => legacy(import("@codemirror/legacy-modes/mode/shell"), "shell"),
  },
  { id: "dockerfile", label: "Dockerfile", exts: ["dockerfile"], names: ["dockerfile"], load: () => legacy(import("@codemirror/legacy-modes/mode/dockerfile"), "dockerFile") },
  {
    id: "ini",
    label: "INI / Properties",
    exts: ["ini", "cfg", "conf", "properties", "env", "editorconfig"],
    names: [".env", ".gitignore", ".gitattributes", ".dockerignore", ".npmrc"],
    load: () => legacy(import("@codemirror/legacy-modes/mode/properties"), "properties"),
  },
  { id: "toml", label: "TOML", exts: ["toml"], load: () => legacy(import("@codemirror/legacy-modes/mode/toml"), "toml") },
  { id: "bat", label: "批处理", exts: ["bat", "cmd"], load: async () => null },
];

const byId = new Map(LANGUAGES.map((l) => [l.id, l]));
export const PLAIN_TEXT = byId.get("text")!;

export function languageById(id: string): CodeLanguage {
  return byId.get(id) ?? PLAIN_TEXT;
}

/** 识别语言：文件名 → 扩展名 → Shebang → 纯文本。 */
export function detectLanguage(fileName: string, firstLine = ""): CodeLanguage {
  const name = (fileName.split("/").pop() ?? fileName).toLowerCase();
  const byName = LANGUAGES.find((l) => l.names?.includes(name));
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && dot < name.length - 1) {
    // 含以点开头的隐藏文件（.env → env）：取最后一个点之后的部分当扩展名
    const ext = name.slice(dot + 1);
    const byExt = LANGUAGES.find((l) => l.exts.includes(ext));
    if (byExt) return byExt;
  }
  const shebang = /^#!\s*(?:\/usr\/bin\/env\s+)?(?:\S*\/)?([A-Za-z0-9_.+-]+)/.exec(firstLine);
  if (shebang) {
    const interp = shebang[1].toLowerCase();
    const bySheb = LANGUAGES.find((l) => l.interpreters?.some((i) => interp === i || interp.startsWith(i)));
    if (bySheb) return bySheb;
  }
  return PLAIN_TEXT;
}

/** 从内容推断缩进：制表符还是空格、空格宽度（多数缩进行的最小公约宽度，默认 4）。 */
export function detectIndent(text: string): { kind: "tab" | "space"; width: number } {
  let tabs = 0;
  let spaces = 0;
  const widths = new Map<number, number>();
  let prev = 0;
  for (const line of text.split("\n", 2000)) {
    const m = /^(\t+| +)\S/.exec(line);
    if (!m) {
      if (line.trim() !== "") prev = 0;
      continue;
    }
    if (m[1][0] === "\t") tabs++;
    else {
      spaces++;
      const diff = Math.abs(m[1].length - prev);
      if (diff >= 2 && diff <= 8) widths.set(diff, (widths.get(diff) ?? 0) + 1);
      prev = m[1].length;
    }
  }
  if (tabs > spaces) return { kind: "tab", width: 4 };
  let best = 4;
  let bestCount = 0;
  for (const [w, c] of widths) {
    if (c > bestCount) {
      best = w;
      bestCount = c;
    }
  }
  return { kind: "space", width: best };
}
