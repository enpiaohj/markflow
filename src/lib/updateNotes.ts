/** 把更新清单里的说明（CHANGELOG 小节，Markdown）整理成可直接显示的行，不暴露 `###`、`**` 等标记。 */

export interface NoteLine {
  kind: "heading" | "bullet" | "text";
  text: string;
}

const HEADING_LABELS: Record<string, string> = {
  added: "新增",
  changed: "变更",
  fixed: "修复",
  security: "安全",
  removed: "移除",
  improved: "改进",
  deprecated: "弃用",
  ui: "界面",
  testing: "测试",
  "known issues": "已知问题",
};

function cleanInline(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/** 前后是 ASCII 字母数字时补一个空格，避免英文单词被折行拼在一起；中文直接连接。 */
function joinWrapped(prev: string, next: string): string {
  return /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(next) ? `${prev} ${next}` : prev + next;
}

export function parseUpdateNotes(md: string): NoteLine[] {
  const out: NoteLine[] = [];
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading) {
      const title = cleanInline(heading[1]);
      out.push({ kind: "heading", text: HEADING_LABELS[title.toLowerCase()] ?? title });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push({ kind: "bullet", text: cleanInline(bullet[1]) });
      continue;
    }
    // 缩进的续行：并入上一条（CHANGELOG 里长条目会折行缩进）
    const last = out[out.length - 1];
    const text = cleanInline(line);
    if (last && last.kind !== "heading" && /^\s/.test(line)) {
      last.text = joinWrapped(last.text, text);
    } else {
      out.push({ kind: "text", text });
    }
  }
  return out;
}
