//! 应用外壳行为：通知区域（托盘）图标、关闭窗口时最小化到通知区域、开机启动。
//!
//! - 「关闭时最小化到通知区域」：开启后关闭窗口只隐藏窗口，应用继续在后台运行；
//!   点击通知区域图标（或用菜单「显示 MarkFlow」）恢复，菜单「退出」才真正退出。
//!   此时未保存的编辑仍保留在内存里（窗口只是隐藏），所以关闭时不需要「放弃修改」确认；
//!   真正退出前由前端弹出确认。
//! - 「开机启动」：写入 / 删除当前用户的 `Run` 注册表项，不需要管理员权限，也不引入新依赖；
//!   启动参数 `--autostart` 表示由开机自动拉起（按设置隐藏到通知区域或最小化）。

use crate::component_manager::run_with_timeout;
use rusqlite::Connection;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

const TRAY_ID: &str = "main";
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "MarkFlow";
/// 开机自动拉起时附带的参数
pub const AUTOSTART_ARG: &str = "--autostart";
const SETTING_CLOSE_TO_TRAY: &str = "close_to_tray";

pub struct ShellState {
    pub close_to_tray: AtomicBool,
}

impl ShellState {
    pub fn new(close_to_tray: bool) -> Self {
        Self { close_to_tray: AtomicBool::new(close_to_tray) }
    }
    pub fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::Relaxed)
    }
}

// ---------------------------------------------------------------------------
// 偏好持久化（settings 表）
// ---------------------------------------------------------------------------

pub fn read_close_to_tray(conn: &Connection) -> bool {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [SETTING_CLOSE_TO_TRAY], |r| r.get::<_, String>(0))
        .map(|v| v == "1")
        .unwrap_or(false)
}

pub fn write_close_to_tray(conn: &Connection, on: bool) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![SETTING_CLOSE_TO_TRAY, if on { "1" } else { "0" }],
    )
    .map(|_| ())
    .map_err(|e| format!("保存设置失败: {e}"))
}

// ---------------------------------------------------------------------------
// 窗口显示 / 通知区域图标
// ---------------------------------------------------------------------------

/// 显示并聚焦主窗口（从托盘 / 最小化 / 二次启动恢复）。
pub fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 按开关创建或移除通知区域图标。
pub fn ensure_tray(app: &AppHandle, enabled: bool) -> Result<(), String> {
    if !enabled {
        let _ = app.remove_tray_by_id(TRAY_ID);
        return Ok(());
    }
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let show = MenuItem::with_id(app, "show", "显示 MarkFlow", true, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&show, &quit]).map_err(|e| e.to_string())?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("MarkFlow")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                // 交给前端：有未保存修改时先确认，再调用 quit_app
                show_main_window(app);
                let _ = app.emit("request-quit", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app).map(|_| ()).map_err(|e| format!("创建通知区域图标失败: {e}"))
}

// ---------------------------------------------------------------------------
// 开机启动（当前用户 Run 注册表项）
// ---------------------------------------------------------------------------

pub fn autostart_enabled() -> bool {
    let mut cmd = Command::new("reg");
    cmd.args(["query", RUN_KEY, "/v", RUN_VALUE]);
    run_with_timeout(&mut cmd, Duration::from_secs(5)).is_ok()
}

pub fn set_autostart(enabled: bool) -> Result<(), String> {
    if enabled {
        let exe = std::env::current_exe().map_err(|e| format!("无法定位程序路径: {e}"))?;
        let value = format!("\"{}\" {AUTOSTART_ARG}", exe.display());
        let mut cmd = Command::new("reg");
        cmd.args(["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &value, "/f"]);
        run_with_timeout(&mut cmd, Duration::from_secs(5)).map_err(|e| format!("设置开机启动失败: {e}"))?;
    } else if autostart_enabled() {
        let mut cmd = Command::new("reg");
        cmd.args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
        run_with_timeout(&mut cmd, Duration::from_secs(5)).map_err(|e| format!("取消开机启动失败: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::run_migrations;

    #[test]
    fn close_to_tray_preference_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        assert!(!read_close_to_tray(&conn), "默认关闭");
        write_close_to_tray(&conn, true).unwrap();
        assert!(read_close_to_tray(&conn));
        write_close_to_tray(&conn, false).unwrap();
        assert!(!read_close_to_tray(&conn));
    }

    #[test]
    fn shell_state_reflects_flag() {
        let s = ShellState::new(false);
        assert!(!s.close_to_tray());
        s.close_to_tray.store(true, Ordering::Relaxed);
        assert!(s.close_to_tray());
    }
}
