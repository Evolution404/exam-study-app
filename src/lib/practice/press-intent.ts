// 单击窗口 500ms：覆盖手机上 300–400ms 的慢速轻点（浏览器经典长按起点）；
// 长按恢复（破坏性操作）延长到 1200ms；501–1199ms 死区不做任何事。
export const QUICK_SYNC_TAP_MAX_MS = 500;
export const QUICK_RESTORE_HOLD_MS = 1200;

export type PressIntent = "tap" | "cancel" | "complete";

export function classifyPressIntent(elapsedMs: number, cancelled: boolean, completed: boolean): PressIntent {
  if (cancelled) return "cancel";
  if (completed || elapsedMs >= QUICK_RESTORE_HOLD_MS) return "complete";
  if (elapsedMs <= QUICK_SYNC_TAP_MAX_MS) return "tap";
  return "cancel";
}
