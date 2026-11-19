/** 自动检查更新的节流与「跳过此版本」判断（纯函数，便于测试）。 */

export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 开启自动检查，且距上次检查已超过间隔（或从未检查 / 时钟回拨）时才检查。 */
export function shouldAutoCheck(enabled: boolean, lastCheckAt: number | null, now: number): boolean {
  if (!enabled) return false;
  if (lastCheckAt === null || lastCheckAt > now) return true;
  return now - lastCheckAt >= AUTO_CHECK_INTERVAL_MS;
}

/** 用户点过「跳过此版本」的同一版本不再自动提示；更新的版本仍会提示。手动检查不受影响。 */
export function isSkippedVersion(skipped: string | null, version: string): boolean {
  return skipped !== null && skipped === version;
}
