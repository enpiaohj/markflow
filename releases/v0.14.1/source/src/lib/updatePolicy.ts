/** 检查更新的时机与重试策略（纯函数，便于测试）。 */

/** 启动后延迟这么久再做首次检查，避免与首屏加载争用。 */
export const STARTUP_CHECK_DELAY_MS = 8000;

/** 运行期间的复检周期：应用常驻（如最小化到通知区域）时也能发现新版本。 */
export const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 复检的轮询粒度：用时间戳比较而不是一个长定时器，睡眠 / 唤醒后也能及时补检。 */
export const RECHECK_POLL_MS = 15 * 60 * 1000;

/** 单次请求超时：避免网络卡住时一直停在「正在检查」。 */
export const CHECK_TIMEOUT_MS = 15000;

/** 失败后的重试间隔（共尝试 1 + 长度 次）。 */
export const CHECK_RETRY_DELAYS_MS = [1500, 4000];

/** 开启自动检查，且距上次成功检查已满周期（或从未成功 / 时钟回拨）时才复检。 */
export function isRecheckDue(enabled: boolean, lastCheckAt: number | null, now: number): boolean {
  if (!enabled) return false;
  if (lastCheckAt === null || lastCheckAt > now) return true;
  return now - lastCheckAt >= RECHECK_INTERVAL_MS;
}

/** 用户点过「跳过此版本」的同一版本不再自动弹窗；更新的版本仍会提示。手动检查不受影响。 */
export function isSkippedVersion(skipped: string | null, version: string): boolean {
  return skipped !== null && skipped === version;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 失败时按间隔重试，全部失败才抛出最后一次的错误。 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  delaysMs: number[] = CHECK_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < delaysMs.length) await sleep(delaysMs[attempt]);
    }
  }
  throw lastError;
}
