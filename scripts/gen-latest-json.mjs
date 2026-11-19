// 生成 Tauri updater 清单 latest.json（随正式版上传到 GitHub Release）。
// 用法：node scripts/gen-latest-json.mjs <版本号> <签名文件.sig> <输出 latest.json>
// 说明：说明文字取自 CHANGELOG.md 中该版本小节；安装包下载地址指向 Release 里规范命名的安装包。
import { readFileSync, writeFileSync } from "node:fs";

const [version, sigPath, outPath] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !sigPath || !outPath) {
  console.error("用法：node scripts/gen-latest-json.mjs <X.Y.Z> <签名文件.sig> <输出 latest.json>");
  process.exit(1);
}

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const header = `## [${version}]`;
const start = changelog.indexOf(header);
if (start < 0) {
  console.error(`CHANGELOG.md 中没有 ${header} 小节`);
  process.exit(1);
}
const rest = changelog.slice(start + header.length);
const nl = rest.indexOf("\n");
const next = rest.search(/\n## \[/);
const notes = rest.slice(nl + 1, next < 0 ? undefined : next).trim();

const signature = readFileSync(sigPath, "utf8").trim();
const tag = `v${version}`;
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `https://github.com/enpiaohj/markflow/releases/download/${tag}/MarkFlow-${tag}-win-x64.exe`,
    },
  },
};
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`已生成 ${outPath}（${tag}，说明 ${notes.length} 字）`);
