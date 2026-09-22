//! 后台任务中心（设计文档 §8.16）：
//! 统一登记扫描、自动重扫等后台任务，提供进度、取消与历史查询。
//! v0.1 任务历史保存在内存（上限 100 条），任务持久化（tasks 表）随 OCR/AI/导出类任务一起交付。

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// 内存中保留的任务历史上限。
const MAX_TASKS: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Running,
    Completed,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    /// 建库全量扫描
    Scan,
    /// 文件监听触发的自动重扫
    Rescan,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    pub kind: TaskKind,
    pub title: String,
    pub status: TaskStatus,
    /// 已处理条目数（扫描类任务无总量预估，不展示百分比）
    pub processed: u64,
    /// 结束后的摘要（如「1,024 个文件 · 2 项跳过」）
    pub detail: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Default)]
struct Inner {
    tasks: Vec<TaskInfo>,
    cancels: HashMap<String, Arc<AtomicBool>>,
}

#[derive(Clone, Default)]
pub struct TaskManager(Arc<Mutex<Inner>>);

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl TaskManager {
    /// 登记新任务并返回 id。
    pub fn begin(&self, kind: TaskKind, title: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let mut inner = self.0.lock().unwrap();
        inner.tasks.insert(
            0,
            TaskInfo {
                id: id.clone(),
                kind,
                title: title.to_string(),
                status: TaskStatus::Running,
                processed: 0,
                detail: None,
                error: None,
                created_at: now,
                updated_at: now,
            },
        );
        Self::prune(&mut inner);
        id
    }

    /// 登记任务的取消旗标；扫描循环周期性检查。
    pub fn attach_cancel(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.0.lock().unwrap().cancels.insert(id.to_string(), flag.clone());
        flag
    }

    /// 更新已处理条目数。
    pub fn progress(&self, id: &str, processed: u64) {
        let mut inner = self.0.lock().unwrap();
        if let Some(task) = inner.tasks.iter_mut().find(|t| t.id == id) {
            task.processed = processed;
            task.updated_at = now_ms();
        }
    }

    /// 结束任务（completed / failed / canceled）。
    pub fn finish(&self, id: &str, status: TaskStatus, detail: Option<String>, error: Option<String>) {
        let mut inner = self.0.lock().unwrap();
        inner.cancels.remove(id);
        if let Some(task) = inner.tasks.iter_mut().find(|t| t.id == id) {
            task.status = status;
            task.detail = detail;
            task.error = error;
            task.updated_at = now_ms();
        }
    }

    /// 请求取消；返回是否存在该任务。
    pub fn cancel(&self, id: &str) -> bool {
        let mut inner = self.0.lock().unwrap();
        let flagged = if let Some(flag) = inner.cancels.get(id) {
            flag.store(true, Ordering::Relaxed);
            true
        } else {
            false
        };
        if let Some(task) = inner.tasks.iter_mut().find(|t| t.id == id && t.status == TaskStatus::Running) {
            task.status = TaskStatus::Canceled;
            task.updated_at = now_ms();
            return true;
        }
        flagged
    }

    pub fn list(&self) -> Vec<TaskInfo> {
        self.0.lock().unwrap().tasks.clone()
    }

    /// 清除非运行中的任务。
    pub fn clear_finished(&self) -> usize {
        let mut inner = self.0.lock().unwrap();
        let before = inner.tasks.len();
        inner.tasks.retain(|t| t.status == TaskStatus::Running);
        before - inner.tasks.len()
    }

    /// 超出上限时丢弃最旧的已结束任务。
    fn prune(inner: &mut Inner) {
        if inner.tasks.len() <= MAX_TASKS {
            return;
        }
        let mut ended_indices: Vec<usize> = inner
            .tasks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.status != TaskStatus::Running)
            .map(|(i, _)| i)
            .collect();
        ended_indices.sort_unstable_by_key(|&i| std::cmp::Reverse(i)); // 从尾部（最旧）删除
        let mut excess = inner.tasks.len() - MAX_TASKS;
        for i in ended_indices {
            if excess == 0 {
                break;
            }
            inner.tasks.remove(i);
            excess -= 1;
        }
    }
}

/// 任务列表变更后调用：向前端广播最新列表。
pub fn emit_tasks(app: &AppHandle, mgr: &TaskManager) {
    let _ = app.emit("tasks:updated", mgr.list());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_lifecycle() {
        let mgr = TaskManager::default();
        let id = mgr.begin(TaskKind::Scan, "扫描索引 · 测试库");
        assert_eq!(mgr.list().len(), 1);
        assert_eq!(mgr.list()[0].status, TaskStatus::Running);

        mgr.progress(&id, 128);
        assert_eq!(mgr.list()[0].processed, 128);

        // 取消后不再处于运行态
        assert!(mgr.cancel(&id));
        assert_eq!(mgr.list()[0].status, TaskStatus::Canceled);

        // 结束接口清理取消旗标
        let id2 = mgr.begin(TaskKind::Rescan, "自动重扫 · 测试库");
        let _flag = mgr.attach_cancel(&id2);
        mgr.finish(&id2, TaskStatus::Completed, Some("10 个文件".into()), None);
        let task = &mgr.list()[0];
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.detail.as_deref(), Some("10 个文件"));

        // 清理只删除已结束任务
        mgr.finish(&id, TaskStatus::Canceled, None, None);
        let removed = mgr.clear_finished();
        assert_eq!(removed, 2);
        assert!(mgr.list().is_empty());
    }

    #[test]
    fn prune_keeps_recent_tasks() {
        let mgr = TaskManager::default();
        for i in 0..(MAX_TASKS + 20) {
            let id = mgr.begin(TaskKind::Scan, &format!("任务{i}"));
            mgr.finish(&id, TaskStatus::Completed, None, None);
        }
        assert_eq!(mgr.list().len(), MAX_TASKS);
        // 最旧的任务（任务0）应被裁剪
        assert!(!mgr.list().iter().any(|t| t.title == "任务0"));
        // 最新任务保留
        assert!(mgr.list().iter().any(|t| t.title == format!("任务{}", MAX_TASKS + 19)));
    }
}
