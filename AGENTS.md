# MarkFlow 项目规则

## Repository Rule

- Product Name：MarkFlow
- Repository：markflow
- Visibility：Private
- Default Branch：main
- Version：Semantic Versioning
- Tag：vMAJOR.MINOR.PATCH
- Commit：Conventional Commits
- Release：GitHub Releases
- Build Artifact：不得长期提交到 Git History
- Secret：不得提交真实凭据
- Documentation：YYYY-MM-DD-内容-vX.Y.md

修改前必须检查 Git Status、当前 Branch 和 Remote。
不得覆盖用户已有未提交修改。
未经明确授权，禁止执行 git reset --hard、git clean -fd、git push --force 或删除 Repository、Branch、Tag、Release。
正式发布前必须完成 Build、Test、CHANGELOG、版本一致性、Tag、Release 和 Secret 检查。

## 项目概述

MarkFlow 是多格式本地文档库桌面应用（详见本地 `docs/01-产品设计/`，该目录不入库）。
核心原则：本地优先、文件为真源、能力分级透明、AI 不越权、操作可恢复、结果可验证。
**不重造 Office 编辑器；所有原文件保持原格式与原路径；SQLite 只存索引与元数据，不作为正文唯一副本。**

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Tauri 2（Rust 后端 + WebView） |
| 前端 | React 19 + TypeScript + Vite |
| 样式 | Tailwind CSS 4（`@theme` 设计令牌，主色 blue-600） |
| 图标 | lucide-react |
| 规划中 | Tiptap/ProseMirror、CodeMirror 6、PDF.js、SQLite FTS5、Pandoc sidecar |

## 常用命令

```powershell
npm run tauri dev      # 开发模式（启动桌面窗口，前端端口固定 1420）
npm run build          # 前端类型检查 + 生产构建（输出 dist/）
npm run tauri build    # 桌面应用完整构建（含安装包）
cd src-tauri && cargo check   # Rust 侧编译检查
```

Rust 工具链为 MSVC：需 rustup（stable-x86_64-pc-windows-msvc）与 VS Build Tools（C++ 工作负载）。

## 代码约定

- 全部自然语言沟通、注释、文档使用简体中文；代码标识符、命令、API 保持原始技术形式。
- 前端组件放 `src/components/`，一级导航视图放 `src/views/`，导航模型集中在 `src/navigation.ts`。
- 设计令牌统一在 `src/index.css` 的 `@theme` 中定义，组件通过 Tailwind 类引用（如 `text-primary-600`），不在组件内写死色值。
- 窗口控制、文件系统等系统能力必须走 Tauri 能力权限（`src-tauri/capabilities/`），按需最小授权。
- 新增 Tauri 命令放 `src-tauri/src/`，在 `lib.rs` 的 `invoke_handler` 注册。
- 不隐藏 Error / Warning；构建或测试失败时定位根因，不得删测试绕过。

## 文档索引

- 产品设计：`docs/01-产品设计/`
- 使用指南：`docs/2026-09-21-MarkFlow使用指南-v1.1.md`
- 开发指南（环境 / 模块职责 / 测试 / 发布流程）：`docs/2026-09-21-MarkFlow开发指南-v1.1.md`
- 变更记录：`CHANGELOG.md`

## 版本与发布

- P0 路线：v0.1 文档库基础 → v0.2 原生编辑与搜索 → v0.3 PDF/Office 与转换 → v0.4 AI 与审阅 → v0.5 正式交付。
- 正式发布前先跑设计文档第 17 节的技术验证 Spike；Spike 未通过时调整能力声明，不得用 UI 掩盖技术限制。
- 发布产物命名 `MarkFlow-v<版本>-win-x64.<ext>`；本地 `releases/` 目录已被 .gitignore 排除。
