# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
