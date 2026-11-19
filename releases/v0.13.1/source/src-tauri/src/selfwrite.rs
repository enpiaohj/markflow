//! 应用自身写入的文件标记：文件监听据此忽略自己触发的事件，
//! 避免每次保存都引发整库重扫，也避免临时文件被当作库内文件。

use crate::lockext::LockExt;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 原子写入临时文件的命名标记。
pub const TEMP_MARKER: &str = ".markflow-";

const WINDOW: Duration = Duration::from_millis(3000);

fn table() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    static T: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn mark(path: &Path) {
    let mut t = table().lock_safe();
    t.retain(|_, at| at.elapsed() < WINDOW * 4);
    t.insert(path.to_path_buf(), Instant::now());
}

pub fn is_recent(path: &Path) -> bool {
    if path
        .file_name()
        .map(|n| n.to_string_lossy().contains(TEMP_MARKER))
        .unwrap_or(false)
    {
        return true;
    }
    table()
        .lock_safe()
        .get(path)
        .map(|at| at.elapsed() < WINDOW)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_and_temp_files() {
        let p = Path::new("D:/lib/a.md");
        assert!(!is_recent(p));
        mark(p);
        assert!(is_recent(p));
        assert!(is_recent(Path::new("D:/lib/a.md.markflow-1234")));
    }
}
