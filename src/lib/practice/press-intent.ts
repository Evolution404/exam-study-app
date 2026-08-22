// 保留这个常量作为交互文档和兼容现有引用的轻点参考值。普通按压不再
// 受 500ms 上限影响：手机上的慢速抬手仍然应该是同步，而不是落入死区。
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
  // Any non-cancelled release before the long-press threshold is a sync.
  // This intentionally removes the old 501–1199ms dead zone: touch release
  // timing varies considerably across mobile browsers and devices.
  return "tap";
}
