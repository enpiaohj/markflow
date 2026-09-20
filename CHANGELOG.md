# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- AI 工作台（v0.4，§8.6/§8.7/§8.9/§12）：
  - OpenAI 兼容 Provider 管理：API Key 存 Windows 凭据库（keyring），不落库、
    不回传前端；连通性测试区分网络 / 认证 / 地址 / 服务端问题；
  - 上下文门禁：发送前组装预览（文件范围、截断提示、字符数与 Token 估算、
    敏感信息扫描），命中需用户知情放行后才发送；
  - 流式对话（Tauri Channel 逐段推送），回答以「【来源 n】」标注引用，
    一键保存为新文档；
  - AI 润色 → 行级差异审阅对话框（应用 / 放弃），应用后由保存闭环自动快照；
  - 文档质量检查（Markdown）：标题层级跳跃、断链、空章节、敏感信息，
    分错误 / 警告 / 建议，编辑器内一键运行与面板展示。
  - 设置页新增 AI Provider 管理区；编辑器新增「AI 助手」侧栏与「检查」面板。

- 转换与导入（v0.3 第二批，§5.3 / §8.13 / §10.3）：
  - 组件管理器：探测 Pandoc / LibreOffice 的路径与版本（设置页实时展示健康状态）；
  - DOCX → Markdown 可编辑副本（Pandoc 3.11 sidecar，参数数组调用 + 60s 超时）：
    转换前预检（加密/损坏阻断；宏、修订、批注风险提示）→ 知情确认 → 副本写入源目录
    （附件进同名 .media）→ 自动重扫入索引 → 直接打开编辑；原文件永不修改；
  - LibreOffice 高保真预览（可选组件，条件显示）：headless 转 PDF（独立 Profile、
    禁交互、120s 超时、临时目录用后即清），未安装时自动降级为提取文本预览；
  - 「导入文件」：DOCX/HTML 自动转 Markdown 入库，其余格式原样复制（同名不覆盖）。
  - 本机已安装 Pandoc 3.11；LibreOffice 按设计定位为用户按需安装的可选组件。
  - Rust 测试新增至 20 项（预检阻断/风险、真实 Pandoc 转换、LibreOffice 环境自适配）。

- PDF 阅读与 Office 快速预览（v0.3 首批）：
  - PDF.js 阅读器：Canvas 渲染、翻页、缩放、跨页文本搜索（命中页码点击定位），
    文件经二进制 IPC 读取且必须已登记在文档库索引中；
  - Office OOXML 安全解析（office.rs，zip + roxmltree，不执行宏、不改源文件）：
    DOCX 段落流 / XLSX 工作表网格（前 200 行 30 列、最多 8 表）/ PPTX 幻灯片大纲；
    扫描时自动提取正文入库（extractor v1 扩展），Office 正文可被全文检索命中
    （含 20MB 上限与 ZIP 炸弹条目限制）；
  - 「使用系统应用打开」：已登记文件调用系统默认应用（Word/Excel/WPS），
    外部保存后由文件监听自动重扫闭环。
  - 测试文档库新增真实 DOCX / XLSX / PPTX / 中文 PDF 样例（含检索关键词）。
  - Rust 测试新增至 17 项（DOCX/XLSX/PPTX 提取与预览、超限与异常文件拒绝）。

- 原生编辑闭环（v0.2 核心）：
  - Markdown 可视化编辑器（Tiptap v3 / ProseMirror 分页画布 + tiptap-markdown 往返，
    支持标题、列表、任务列表、表格、引用、代码块、图片）与源码模式（CodeMirror 6，
    Markdown/JSON/YAML 语法高亮）随时互切，Markdown 文件为持久化真源。
  - 文本类格式（MD/TXT/代码/JSON/YAML/XML/配置/CSV）双击即编辑，Ctrl+S 保存。
  - 保存闭环：外部修改冲突检测（基线 mtime 三选一对话框：覆盖保存 / 重新载入 /
    取消）、临时文件 + fsync + 原子替换、保存后自动重建该文件全文索引。
  - 历史快照与恢复：每次保存前自动快照（每文件保留 20 个），编辑器内置历史面板
    与「历史」恢复中心（按库浏览、一键恢复，恢复前自动再快照）。

- 后台任务中心（§8.16 首批）：任务管理器登记扫描/自动重扫任务，
  实时进度（已处理条目数）、取消（扫描循环检查取消旗标）、完成摘要、
  失败原因与历史清理（内存保留 100 条，持久化随 OCR/AI/导出任务交付）；
  「任务」视图 + 状态栏「N 个任务运行中」入口 + `tasks:updated` 事件。
- 性能 Spike（§17.1 第 1 项）：5 万混合文件库生成 → 扫描+提取+FTS5 索引 →
  中文关键词全文检索 → 文件名检索 → 全量重建 的完整实测
  （`cargo test --profile spike spike_50k -- --ignored --nocapture`）。
- 文档库核心（v0.1 第一批功能）：
  - Rust 侧格式注册表（17 类格式 + 回退）、SQLite 索引库（libraries / files 表）、
    目录扫描（默认与自定义排除规则、隐藏项跳过、数量上限保护）与后台扫描事件。
  - Tauri 命令：`list_libraries` / `quick_scan_library` / `create_library` / `open_library` /
    `remove_library` / `list_children` / `get_file_detail`；接入 `tauri-plugin-dialog`。
  - 前端建库向导（三步：选择文件夹 → 索引设置 → 确认创建，含轻量扫描预览与隐私说明）。
  - 「文档库」三栏视图：目录树（懒加载）、面包屑、可排序文件列表、右侧详情面板。
  - 标题栏文档库切换菜单（打开 / 移除索引 / 关闭），「开始」页最近文档库列表，
    状态栏展示当前库与索引进度。
- 文件监听与自动重索引：notify 递归监听当前库，事件去抖（1.2 秒静默）后全量重扫，
  通过 `library:changed` 事件刷新前端；排除目录内的事件不触发重扫；
  被占用/无权限文件跳过计数，不再中断扫描。
- 文本提取与全文检索：Markdown/文本/代码/JSON/YAML/XML/配置/CSV 提取正文
  （2MB 上限，UTF-8 lossy），存入 extracted_content 与 FTS5 trigram 全文索引
  （支持中文子串匹配）；≥3 字符走 FTS（文件名+正文），短词回退文件名 LIKE。
- 「搜索」视图：当前库范围搜索、命中片段【】高亮、文件名/正文命中标记，
  点击结果跳转文档库视图定位并选中文件；标题栏搜索框与 Ctrl+K 快捷键接入。
- 测试文档库基线：D:\MarkFlow（01_项目管理 ~ 05_会议与归档、assets、参考资料，
  24 个多格式文件，含 node_modules 排除验证目录）。
- Rust 单元测试新增至 9 项（新增提取与搜索往返、监听路径过滤）。

### Changed

- 格式显示名以 Rust 格式注册表为唯一来源（FileEntryDto.formatLabel），
  前端仅保留图标与配色映射。
- 扫描写入改为单事务（含 FTS 清理），失败可回滚，不产生半更新索引。

## [0.1.0] - 2026-09-20

### Added

- Tauri 2 + React 19 + TypeScript + Vite + Tailwind CSS 4 工程骨架。
- 应用外壳：无边框窗口、自定义标题栏（库切换占位、全局搜索入口、窗口控制）、
  活动栏一级导航（开始 / 文档库 / 搜索 / 关系图 / 任务 / 历史 / 设置）、底部状态栏。
- 设计令牌（主色 blue-600、Microsoft YaHei 字体栈）与浅色主题。
- Rust 侧 `app_info` 命令；窗口控制所需 Tauri 能力权限。
- 仓库标准文件：README、CHANGELOG、AGENTS.md、.gitignore、.editorconfig、.gitattributes。
- 纳入产品设计文档与 UI 概念设计图（`docs/产品设计/`）。

[Unreleased]: https://github.com/enpiaohj/markflow/compare/HEAD
