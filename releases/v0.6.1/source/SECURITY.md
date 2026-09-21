# 安全策略

## 支持的版本

只对最新的正式版本（见 [Releases](https://github.com/enpiaohj/markflow/releases)）提供安全修复。

## 报告漏洞

请**不要**在公开 Issue 中披露安全漏洞。使用 GitHub 的私密漏洞报告：
仓库页面 → **Security** → **Report a vulnerability**（<https://github.com/enpiaohj/markflow/security/advisories/new>）。

报告中请尽量包含：影响的版本、复现步骤、影响范围（例如文件读写越权、命令注入、敏感信息泄露）。收到后会尽快确认并在修复发布前保密。

## 安全设计要点

- 所有文件操作在本地完成；应用不收集遥测，唯一的对外请求来自用户自行配置的 AI Provider。
- Pandoc / LibreOffice / Edge 等外部工具以参数数组调用（无 Shell 拼接）、带超时、独立临时目录。
- API Key 存于 Windows 凭据库，不落库、不回传前端。
- 窗口与文件系统能力按最小权限授权（`src-tauri/capabilities/`）。
