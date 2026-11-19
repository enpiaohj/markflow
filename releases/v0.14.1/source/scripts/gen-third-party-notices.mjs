// 从 package-lock.json（生产依赖）与 `cargo metadata` 生成 THIRD-PARTY-NOTICES.md。
// 用法（仓库根目录）：node scripts/gen-third-party-notices.mjs
import fs from "node:fs";
import { execSync } from "node:child_process";

const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const npm = {};
for (const [p, v] of Object.entries(lock.packages)) {
  if (!p || v.dev) continue;
  const name = p.replace(/^.*node_modules\//, "");
  let lic = v.license;
  try {
    const j = JSON.parse(fs.readFileSync(`${p}/package.json`, "utf8"));
    lic = (typeof j.license === "string" ? j.license : j.license && j.license.type) || lic;
  } catch {
    /* 未安装的平台可选包：沿用锁文件里的许可字段 */
  }
  (npm[lic || "未标注"] ??= new Set()).add(`${name}@${v.version}`);
}

const meta = JSON.parse(
  execSync("cargo metadata --format-version 1 --locked", { cwd: "src-tauri", maxBuffer: 1 << 28 }).toString(),
);
const ws = new Set(meta.workspace_members);
const cargo = {};
for (const p of meta.packages) {
  if (ws.has(p.id)) continue;
  const lic = (p.license || "未标注").replace(/\//g, " OR ");
  (cargo[lic] ??= new Set()).add(`${p.name}@${p.version}`);
}

const count = (o) => Object.values(o).reduce((a, s) => a + s.size, 0);
const section = (o) =>
  Object.entries(o)
    .sort((a, b) => b[1].size - a[1].size)
    .map(([l, s]) => `### ${l}（${s.size}）\n\n${[...s].sort().join("、")}\n`)
    .join("\n");
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;

const out = `# 第三方组件声明

MarkFlow 以 **GPL-3.0-only** 发布（见 [LICENSE](LICENSE)）。下列第三方组件按各自许可随应用分发或参与构建，其许可均与 GPL-3.0 兼容（MIT / Apache-2.0 / BSD / ISC / MPL-2.0 / Zlib / Unicode / CC0 等宽松或弱 Copyleft 许可；双许可组件按可兼容的一项使用，如 jszip 选用 MIT）。

> 本清单由锁文件（package-lock.json、Cargo.lock）在 v${version} 发布时生成（\`node scripts/gen-third-party-notices.mjs\`），含平台条件依赖（仅在对应平台编译）与构建期依赖；各组件版权归其作者所有，许可全文见其上游仓库。

## 不随应用分发的外部工具

Pandoc（GPL-2.0-or-later）、LibreOffice（MPL-2.0 / LGPL-3.0-or-later）、Microsoft Edge（专有）与 Windows OCR（系统组件）**不随 MarkFlow 分发**：应用仅在用户本机已安装时，以独立进程（参数数组、无 Shell 拼接）调用它们；未安装时相应功能自动降级。

## 前端与构建（npm，生产依赖树，共 ${count(npm)} 项）

${section(npm)}
## Rust 后端（Cargo，共 ${count(cargo)} 项）

${section(cargo)}`;
fs.writeFileSync("THIRD-PARTY-NOTICES.md", out);
console.log(`npm ${count(npm)} 项，cargo ${count(cargo)} 项`);
