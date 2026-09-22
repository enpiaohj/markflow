import { CheckCircle2, CircleDashed, ListTodo, Loader2, Trash2, TriangleAlert, XCircle } from "lucide-react";
import { useTasks } from "../components/TasksContext";
import { formatTime } from "../lib/format";
import type { TaskInfo } from "../lib/types";

const STATUS_META: Record<
  TaskInfo["status"],
  { label: string; chipClass: string; icon: typeof Loader2 }
> = {
  running: { label: "运行中", chipClass: "bg-primary-50 text-primary-700", icon: Loader2 },
  completed: { label: "已完成", chipClass: "bg-emerald-50 text-emerald-700", icon: CheckCircle2 },
  failed: { label: "失败", chipClass: "bg-red-50 text-red-600", icon: TriangleAlert },
  canceled: { label: "已取消", chipClass: "bg-gray-100 text-gray-500", icon: XCircle },
};

const KIND_LABEL: Record<TaskInfo["kind"], string> = {
  scan: "扫描索引",
  rescan: "自动重扫",
};

function TaskRow({ task, onCancel }: { task: TaskInfo; onCancel: (id: string) => void }) {
  const meta = STATUS_META[task.status];
  const Icon = meta.icon;
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${meta.chipClass}`}>
        <Icon className={`h-4 w-4 ${task.status === "running" ? "animate-spin" : ""}`} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-medium text-gray-900">{task.title}</span>
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${meta.chipClass}`}>{meta.label}</span>
          <span className="ml-auto shrink-0 text-[11px] text-gray-400">{formatTime(task.updatedAt)}</span>
        </div>
        {task.status === "running" && (
          <p className="mt-0.5 text-xs text-gray-500">
            {KIND_LABEL[task.kind]} · 已处理 {task.processed.toLocaleString()} 项…
          </p>
        )}
        {task.status !== "running" && task.detail && (
          <p className="mt-0.5 text-xs text-gray-500">{KIND_LABEL[task.kind]} · {task.detail}</p>
        )}
        {task.error && (
          <p className="mt-1 break-all rounded bg-red-50 px-2 py-1 text-xs text-red-600">{task.error}</p>
        )}
      </div>
      {task.status === "running" && (
        <button
          type="button"
          onClick={() => onCancel(task.id)}
          className="shrink-0 rounded-md border border-gray-200 px-2 py-1 text-[11px] text-gray-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
        >
          取消
        </button>
      )}
    </li>
  );
}

/** 「任务」视图：后台任务中心（设计文档 §8.16，v0.1 覆盖扫描/重扫类任务） */
export default function TasksView() {
  const { tasks, clearFinished, cancelTask } = useTasks();
  const finishedCount = tasks.filter((t) => t.status !== "running").length;

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-6 py-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">后台任务</h2>
          <p className="mt-0.5 text-[13px] text-gray-500">
            索引、转换、导入、交付等后台任务的进度、失败原因与重试入口
          </p>
        </div>
        <button
          type="button"
          onClick={() => void clearFinished()}
          disabled={finishedCount === 0}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-[13px] text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Trash2 className="h-3.5 w-3.5" />
          清除已完成（{finishedCount}）
        </button>
      </div>

      {tasks.length === 0 ? (
        <div className="mt-6 flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-gray-200 text-gray-400">
          <ListTodo className="h-8 w-8" />
          <p className="mt-3 text-sm">暂无后台任务</p>
          <p className="mt-1 text-xs">添加文档库或文件变化触发重扫时，任务会出现在这里</p>
        </div>
      ) : (
        <ul className="mt-4 mb-6 min-h-0 flex-1 overflow-y-auto divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} onCancel={(id) => void cancelTask(id)} />
          ))}
        </ul>
      )}

      <p className="mt-auto flex items-center gap-1.5 pb-4 text-xs text-gray-400">
        <CircleDashed className="h-3.5 w-3.5" />
        任务历史保存在内存中，重启应用后清空；任务持久化与 OCR / AI / 导出类任务按路线图交付。
      </p>
    </div>
  );
}
