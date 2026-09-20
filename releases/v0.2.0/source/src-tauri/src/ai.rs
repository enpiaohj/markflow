//! AI 工作台（设计文档 §8.6、§12 Prompt 注入与密钥控制）：
//! OpenAI 兼容 Provider 管理；API Key 存 Windows 凭据库（keyring），不经前端、不落库；
//! 上下文门禁：发送前敏感信息扫描，命中需用户明确放行；流式对话经 Tauri Channel 推送。

use crate::sensitive;
use futures_util::StreamExt;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

pub const KEYRING_SERVICE: &str = "MarkFlow";
/// 单个上下文文件字符上限
const MAX_CONTEXT_FILE_CHARS: usize = 60_000;
/// 上下文总字符上限
const MAX_CONTEXT_TOTAL_CHARS: usize = 200_000;

// ---------------------------------------------------------------------------
// Provider 配置（DB settings 表 + keyring 密钥）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    /// OpenAI 兼容基础地址（如 https://api.deepseek.com/v1）
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSaveRequest {
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

pub fn read_providers(conn: &Connection) -> Vec<ProviderConfig> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = 'ai_providers'",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|json| serde_json::from_str(&json).ok())
    .unwrap_or_default()
}

fn write_providers(conn: &Connection, providers: &[ProviderConfig]) -> Result<(), String> {
    let json = serde_json::to_string(providers).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('ai_providers', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [json],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn keyring_entry(provider_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("provider/{provider_id}"))
        .map_err(|e| format!("无法访问系统凭据库: {e}"))
}

pub fn list_providers(conn: &Connection) -> Vec<ProviderConfig> {
    read_providers(conn)
}

pub fn save_provider(conn: &Connection, req: ProviderSaveRequest) -> Result<ProviderConfig, String> {
    if req.name.trim().is_empty() || req.base_url.trim().is_empty() || req.model.trim().is_empty() {
        return Err("名称、接口地址与模型不能为空".into());
    }
    let base_url = req.base_url.trim().trim_end_matches('/').to_string();
    let id = uuid::Uuid::new_v4().to_string();

    keyring_entry(&id)?.set_password(&req.api_key).map_err(|e| format!("密钥写入凭据库失败: {e}"))?;

    let provider = ProviderConfig {
        id,
        name: req.name.trim().to_string(),
        base_url,
        model: req.model.trim().to_string(),
    };
    let mut providers = read_providers(conn);
    providers.push(provider.clone());
    write_providers(conn, &providers)?;
    Ok(provider)
}

pub fn delete_provider(conn: &Connection, id: &str) -> Result<(), String> {
    let mut providers = read_providers(conn);
    providers.retain(|p| p.id != id);
    write_providers(conn, &providers)?;
    // 密钥同步删除（失败不影响列表更新）
    if let Ok(entry) = keyring_entry(id) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

pub fn provider_key(provider_id: &str) -> Result<String, String> {
    keyring_entry(provider_id)?
        .get_password()
        .map_err(|e| format!("从凭据库读取密钥失败: {e}"))
}

// ---------------------------------------------------------------------------
// 连通性测试（区分网络 / 认证 / 地址问题，§19 验收要求）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    /// network | auth | not_found | server | ok
    pub category: String,
    pub message: String,
}

pub async fn test_provider(base_url: &str, api_key: &str) -> TestResult {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return TestResult { ok: false, category: "network".into(), message: format!("客户端构建失败: {e}") },
    };
    let url = format!("{base_url}/models");
    match client.get(&url).bearer_auth(api_key).send().await {
        Err(e) if e.is_timeout() || e.is_connect() => TestResult {
            ok: false,
            category: "network".into(),
            message: "网络错误：无法连接到接口地址".into(),
        },
        Err(e) => TestResult { ok: false, category: "network".into(), message: format!("请求失败: {e}") },
        Ok(resp) => match resp.status().as_u16() {
            200 => TestResult { ok: true, category: "ok".into(), message: "连接成功，密钥有效".into() },
            401 | 403 => TestResult { ok: false, category: "auth".into(), message: "认证失败：API Key 无效或无权限".into() },
            404 => TestResult { ok: false, category: "not_found".into(), message: "接口地址不存在：请检查 Base URL（通常以 /v1 结尾）".into() },
            code => TestResult { ok: false, category: "server".into(), message: format!("服务返回 {code}") },
        },
    }
}



// ---------------------------------------------------------------------------
// 上下文组装与门禁
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPreview {
    pub files: Vec<ContextFile>,
    pub total_chars: usize,
    /// 粗略估算：ASCII 每 4 字符 ≈ 1 token，中日韩字符 ≈ 1 token
    pub estimated_tokens: usize,
    pub sensitive_hits: Vec<sensitive::SensitiveHit>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextFile {
    pub relative_path: String,
    pub chars: usize,
    pub truncated: bool,
    pub skipped: Option<String>,
}

fn extract_context_text(root: &Path, rel: &str) -> Result<String, String> {
    let path = root.join(rel);
    let format = crate::format::detect_format(rel.rsplit('/').next().unwrap_or(rel));
    if matches!(format, "word" | "excel" | "powerpoint") {
        return crate::office::extract_text(&path, format);
    }
    if !crate::library::TEXT_FORMATS.contains(&format) {
        return Err(format!("格式「{}」暂不支持作为 AI 上下文", crate::format::format_label(&format)));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取 {rel} 失败: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// 粗略估算：ASCII 每 4 字符 ≈ 1 token；非 ASCII（多为中日韩）约 1 字符 ≈ 1 token。
fn estimate_tokens(text: &str) -> usize {
    let ascii = text.chars().filter(|c| c.is_ascii()).count();
    let non_ascii = text.chars().count() - ascii;
    ascii / 4 + non_ascii
}

/// 组装上下文预览（门禁第一步：不发送，只展示范围与敏感扫描结果）。
pub fn prepare_context_with(root: &str, paths: &[String]) -> Result<ContextPreview, String> {
    let root_path = std::path::PathBuf::from(root);
    let mut files = Vec::new();
    let mut context = String::new();
    let mut total = 0usize;

    for rel in paths {
        if total >= MAX_CONTEXT_TOTAL_CHARS {
            files.push(ContextFile {
                relative_path: rel.clone(),
                chars: 0,
                truncated: false,
                skipped: Some("已达上下文总量上限，未包含".into()),
            });
            continue;
        }
        match extract_context_text(&root_path, rel) {
            Ok(text) => {
                let budget = MAX_CONTEXT_FILE_CHARS.min(MAX_CONTEXT_TOTAL_CHARS - total);
                let truncated = text.chars().count() > budget;
                let taken: String = text.chars().take(budget).collect();
                total += taken.chars().count();
                files.push(ContextFile {
                    relative_path: rel.clone(),
                    chars: taken.chars().count(),
                    truncated,
                    skipped: None,
                });
                context.push_str(&format!("\n\n【来源 {}】{}\n", files.len(), rel));
                context.push_str(&taken);
            }
            Err(e) => files.push(ContextFile {
                relative_path: rel.clone(),
                chars: 0,
                truncated: false,
                skipped: Some(e),
            }),
        }
    }

    let hits = sensitive::scan(&context);
    Ok(ContextPreview {
        estimated_tokens: estimate_tokens(&context),
        total_chars: total,
        files,
        sensitive_hits: hits,
    })
}

// ---------------------------------------------------------------------------
// 流式对话
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    pub provider_id: String,
    pub library_id: String,
    /// 作为上下文的库内文件（用户显式选择）
    pub context_paths: Vec<String>,
    pub messages: Vec<ChatMessage>,
    /// 用户已看到敏感扫描结果并放行
    pub allow_sensitive: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatOutcome {
    /// 本次实际使用的模型（回退/网关重写时如实标注，§8.6 主备规则）
    pub model: String,
    pub sensitive_hit_count: usize,
}

/// 流式对话：上下文门禁 → 组装消息 → SSE 流式 → Channel 逐段推送。
pub async fn chat(
    root: &str,
    provider: ProviderConfig,
    api_key: String,
    channel: Channel<String>,
    request: AiChatRequest,
) -> Result<ChatOutcome, String> {
    let preview = prepare_context_with(root, &request.context_paths)?;

    // 上下文门禁：命中敏感信息且未放行 → 拒绝发送
    if !preview.sensitive_hits.is_empty() && !request.allow_sensitive {
        let hits_json = serde_json::to_string(&preview.sensitive_hits).unwrap_or_default();
        return Err(format!("SENSITIVE::{hits_json}"));
    }

    let mut messages: Vec<serde_json::Value> = vec![serde_json::json!({
        "role": "system",
        "content": "你是 MarkFlow 文档库的 AI 助手。回答时必须基于提供的上下文资料；\
            引用资料时使用「【来源 n】」标注（n 为来源编号）；上下文不足时如实说明。\
            全程使用简体中文回答。"
    })];
    if !preview.files.is_empty() {
        let context_body = build_context_body(root, &request.context_paths)?;
        messages.push(serde_json::json!({
            "role": "system",
            "content": format!(
                "以下是用户选择的 {} 个库内文档，回答时用「【来源 n】」标注引用（n 为来源编号）：{}",
                preview.files.len(),
                context_body
            ),
        }));
    }
    for m in &request.messages {
        messages.push(serde_json::json!({ "role": m.role, "content": m.content }));
    }

    let url = format!("{}/chat/completions", provider.base_url);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("客户端构建失败: {e}"))?;
    let resp = client
        .post(&url)
        .bearer_auth(&api_key)
        .json(&serde_json::json!({
            "model": provider.model,
            "messages": messages,
            "stream": true,
        }))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() || e.is_connect() {
                "网络错误：无法连接 AI Provider".to_string()
            } else {
                format!("请求失败: {e}")
            }
        })?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return match status.as_u16() {
            401 | 403 => Err("认证失败：API Key 无效或无权限".into()),
            404 => Err("接口地址或模型不存在：请检查 Base URL 与模型名".into()),
            _ => Err(format!("AI 服务返回 {status}: {}", body.chars().take(300).collect::<String>())),
        };
    }

    // 解析 SSE：data: {...} 行，取 choices[0].delta.content
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("流中断: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(pos) = buffer.find('\n') {
            let line: String = buffer.drain(..pos + 1).collect();
            let line = line.trim();
            if let Some(data) = line.strip_prefix("data: ") {
                let data = data.trim();
                if data == "[DONE]" {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(content) = value["choices"][0]["delta"]["content"].as_str() {
                        if !content.is_empty() {
                            channel.send(content.to_string()).map_err(|e| format!("推送失败: {e}"))?;
                        }
                    }
                }
            }
        }
    }

    Ok(ChatOutcome {
        model: provider.model,
        sensitive_hit_count: preview.sensitive_hits.len(),
    })
}

fn build_context_body(root: &str, paths: &[String]) -> Result<String, String> {
    let root_path = std::path::PathBuf::from(root);
    let mut body = String::new();
    let mut total = 0usize;
    for (idx, rel) in paths.iter().enumerate() {
        if total >= MAX_CONTEXT_TOTAL_CHARS {
            break;
        }
        if let Ok(text) = extract_context_text(&root_path, rel) {
            let budget = MAX_CONTEXT_FILE_CHARS.min(MAX_CONTEXT_TOTAL_CHARS - total);
            let taken: String = text.chars().take(budget).collect();
            total += taken.chars().count();
            body.push_str(&format!("\n\n【来源 {}】{}\n{}", idx + 1, rel, taken));
        }
    }
    Ok(body)
}

use std::path::Path;
