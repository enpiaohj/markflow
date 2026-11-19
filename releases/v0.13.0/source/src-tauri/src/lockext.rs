//! 互斥锁「中毒可恢复」：std 的 `Mutex` 在持锁线程 panic 后会进入中毒状态，
//! 此后每次 `lock().unwrap()` 都会 panic——对共享的数据库连接而言，一次意外 panic
//! 就会让所有后续命令失败，直到重启应用。
//!
//! 这里统一改为取回内部数据继续使用：
//! - 数据库连接：rusqlite 的 `Transaction` 在 panic 展开时 drop 即回滚，连接本身仍可用；
//! - 任务表 / 监听表 / 缓存等内存结构：最坏情况是某条记录状态不完整，远好于整体不可用。

use std::sync::{Mutex, MutexGuard};

pub trait LockExt<T> {
    /// 加锁；锁已中毒时取回内部数据继续使用（不 panic）。
    fn lock_safe(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_safe(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn poisoned_mutex_stays_usable() {
        let m = Arc::new(Mutex::new(1));
        let m2 = Arc::clone(&m);
        // 持锁期间 panic → 锁中毒
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("模拟命令执行中 panic");
        })
        .join();
        assert!(m.is_poisoned());
        assert!(m.lock().is_err(), "普通 lock() 在中毒后返回错误（unwrap 会 panic）");
        *m.lock_safe() += 1;
        assert_eq!(*m.lock_safe(), 2, "lock_safe 在中毒后仍可正常读写");
    }

    #[test]
    fn poisoned_db_connection_rolls_back_and_stays_usable() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1);").unwrap();
        let m = Arc::new(Mutex::new(conn));
        let m2 = Arc::clone(&m);
        // 事务写入一半时 panic：Transaction 在展开时 drop → 回滚
        let _ = std::thread::spawn(move || {
            let g = m2.lock().unwrap();
            let tx = g.unchecked_transaction().unwrap();
            tx.execute("INSERT INTO t VALUES (2)", []).unwrap();
            panic!("模拟事务中途 panic");
        })
        .join();
        assert!(m.is_poisoned());
        let g = m.lock_safe();
        let n: i64 = g.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "未提交的写入已回滚");
        g.execute("INSERT INTO t VALUES (3)", []).unwrap(); // 连接仍可继续使用
    }
}
