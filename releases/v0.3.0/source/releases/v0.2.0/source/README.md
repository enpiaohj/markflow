# MarkFlow

面向项目与企业文档的**多格式本地文档库、专业写作、AI 协作和正式交付工作台**。
以普通本地文件夹为基础，统一管理 Markdown、Word、PDF、Excel、PPT、图片、代码等格式，
提供跨格式搜索、文档关联、AI 分析、审阅与正式交付能力。文件始终保存在原位置，本地优先、无需登录。

## 核心功能（规划）

- **多格式文档库**：目录树、文件列表、智能集合；格式能力分级（原生编辑 / 转换编辑 / 深度阅读 / 快速预览 / 外部打开）。
- **专业原生编辑**：Markdown 可视化分页画布（Tiptap/ProseMirror）+ 源码模式（CodeMirror 6）。
- **统一搜索**：文件名、正文、PDF 文本层、Office 文本、OCR 与转写文本的本地统一索引（SQLite FTS5）。
- **跨文档关联**：链接、手动关联与自动建议，关系图视图，文件移动后按稳定 ID 恢复。
- **AI 协作**：上下文门禁、敏感信息扫描、带引用问答、差异审阅后应用。
- **正式交付**：模板、预检、验证、历史，DOCX / PDF / HTML / Markdown / ZIP 可验证导出。

完整产品设计见《[产品设计与技术实施方案 v2.0](docs/产品设计/2026-09-20-MarkFlow-多格式本地文档库产品设计与技术实施方案-v2.0.md)》与 [UI 概念设计图](docs/产品设计/UI概念设计图/)。

## 当前版本

v0.2.0（P0 功能闭环：文档库 / 编辑 / 搜索 / AI / OCR / 批注 / 交付中心）。

已实现：Tauri 2 + React 19 + TypeScript + Vite + Tailwind CSS 4 工程骨架；
无边框窗口、自定义标题栏（含文档库切换）、活动栏导航、状态栏；
**建库向导**（三步：选择文件夹 → 索引设置 → 确认创建）、
**文档库三栏视图**（目录树懒加载、文件列表排序、详情面板）、
**目录扫描与 SQLite 索引**（默认/自定义排除规则、后台扫描进度）、
**文件监听**（外部修改防抖重扫、自动刷新）、
**全文检索**（文本类格式正文提取 + FTS5 trigram，支持中文子串匹配）、
**搜索视图**（命中片段高亮、结果定位跳转、Ctrl+K）、
**后台任务中心**（扫描进度、取消、失败原因、历史）、
**原生编辑**（Markdown 可视化画布 + 源码模式、文本/代码/JSON/YAML 编辑、
Ctrl+S 原子保存、外部冲突检测、历史快照与一键恢复）、
**PDF 阅读**（PDF.js 渲染、翻页缩放、全文搜索）、
**Office 快速预览**（DOCX/XLSX/PPTX 安全提取，正文可检索，系统应用打开）、
**转换与导入**（Pandoc：DOCX→可编辑 Markdown 副本、DOCX/HTML 导入；
可选 LibreOffice 高保真预览；组件健康状态）、
**AI 工作台**（OpenAI 兼容 Provider、密钥入凭据库、上下文门禁与敏感扫描、
流式引用问答、AI 润色差异审阅、文档质量检查）、
**正式交付中心**（质量门禁预检、来源 SHA-256 冻结、MD/HTML/DOCX/PDF/ZIP
多格式管线、原子落盘、交付历史）、
**图片 OCR 与批注**（Windows OCR 文字识别入索引、选中文本批注与重定位检测）。
详见 [CHANGELOG](CHANGELOG.md)。

## 系统要求

- Windows 10/11 x64（首发平台）
- WebView 2 Runtime（Windows 11 内置）
- 开发环境：Node.js ≥ 20、Rust stable（MSVC 工具链）、Visual Studio Build Tools（C++ 工作负载）

## 项目结构

```
MarkFlow/
├─ docs/产品设计/          # 产品设计文档与 UI 概念设计图
├─ public/                  # 静态资源
├─ src/                     # React 前端
│  ├─ components/           # 标题栏、活动栏、状态栏等
│  ├─ views/                # 一级导航视图
│  ├─ navigation.ts         # 导航模型
│  └─ index.css             # Tailwind 与设计令牌
├─ src-tauri/               # Tauri 2（Rust 后端）
│  ├─ src/                  # Rust 入口与命令
│  ├─ capabilities/         # Tauri 能力权限
│  └─ tauri.conf.json       # 应用与窗口配置
└─ index.html / vite.config.ts / package.json
```

## 开发环境

```powershell
# 前置：安装 Rust（https://rustup.rs）与 VS Build Tools（C++ 工作负载）
npm install
```

## Build / Run / Test

```powershell
# 开发模式（热重载，启动桌面窗口）
npm run tauri dev

# 前端生产构建（tsc + vite build）
npm run build

# 桌面应用构建（生成安装包）
npm run tauri build

# Rust 侧编译检查
cd src-tauri; cargo check
```

## Test

当前无自动化测试（工程骨架阶段）。测试体系（Vitest、RTL、Playwright、Rust tests、Golden Tests）
按设计文档第 18 节随功能实现逐步建立。

## Release

- 遵循 Semantic Versioning；正式发布创建 `releases/vX.Y.Z/` 快照并上传 GitHub Releases。
- 发布产物命名：`MarkFlow-v<版本>-win-x64.<ext>`。
- 详见 `AGENTS.md` 的 Repository Rule。

## 文档

- 产品设计：`docs/产品设计/`
- 变更记录：[CHANGELOG.md](CHANGELOG.md)
- 项目规则：[AGENTS.md](AGENTS.md)
