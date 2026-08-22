// 轻点只在 500ms 内触发同步。超过轻点窗口代表用户已经表现出长按意图；
// 若没有持续到恢复阈值便松手，应视为反悔并取消，绝不能降级成同步。
export const QUICK_SYNC_TAP_MAX_MS = 500;
export const QUICK_RESTORE_HOLD_MS = 1200;

export type PressIntent = "tap" | "cancel" | "complete";

/** Ignore normal finger jitter, but yield to an intentional page gesture. */
export function shouldCancelQuickSyncMove(deltaX: number, deltaY: number): boolean {
  const verticalScroll = Math.abs(deltaY) >= 18 && Math.abs(deltaY) >= Math.abs(deltaX) * 1.2;
  const horizontalEscape = Math.abs(deltaX) >= 24;
  return verticalScroll || horizontalEscape;
}

export function classifyPressIntent(elapsedMs: number, cancelled: boolean, completed: boolean): PressIntent {
  if (cancelled) return "cancel";
  if (completed || elapsedMs >= QUICK_RESTORE_HOLD_MS) return "complete";
  if (elapsedMs <= QUICK_SYNC_TAP_MAX_MS) return "tap";
  return "cancel";
}
