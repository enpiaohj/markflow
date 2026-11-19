import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../lib/api";
import type { TaskInfo } from "../lib/types";

interface TasksContextValue {
  tasks: TaskInfo[];
  runningCount: number;
  cancelTask: (id: string) => Promise<void>;
  clearFinished: () => Promise<void>;
}

const TasksContext = createContext<TasksContextValue | null>(null);

/** 后台任务列表：由 Rust 侧 `tasks:updated` 事件驱动（设计文档 §8.16） */
export function TasksProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);

  useEffect(() => {
    void api.listTasks().then(setTasks).catch((err) => console.error("加载任务列表失败", err));
    const unlisten = listen<TaskInfo[]>("tasks:updated", (event) => setTasks(event.payload));
    return () => {
      void unlisten.then((un) => un());
    };
  }, []);

  const cancelTask = useCallback(async (id: string) => {
    try {
      await api.cancelTask(id);
    } catch (err) {
      console.error("取消任务失败", err);
    }
  }, []);

  const clearFinished = useCallback(async () => {
    try {
      await api.clearFinishedTasks();
    } catch (err) {
      console.error("清理任务失败", err);
    }
  }, []);

  const value = useMemo<TasksContextValue>(
    () => ({
      tasks,
      runningCount: tasks.filter((t) => t.status === "running").length,
      cancelTask,
      clearFinished,
    }),
    [tasks, cancelTask, clearFinished],
  );

  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>;
}

export function useTasks(): TasksContextValue {
  const ctx = useContext(TasksContext);
  if (!ctx) throw new Error("useTasks 必须在 TasksProvider 内使用");
  return ctx;
}
