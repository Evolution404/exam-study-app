export const QUICK_SYNC_TAP_MAX_MS = 250;
export const QUICK_RESTORE_HOLD_MS = 900;

export type PressIntent = "tap" | "cancel" | "complete";

export function classifyPressIntent(elapsedMs: number, cancelled: boolean, completed: boolean): PressIntent {
  if (cancelled) return "cancel";
  if (completed || elapsedMs >= QUICK_RESTORE_HOLD_MS) return "complete";
  if (elapsedMs <= QUICK_SYNC_TAP_MAX_MS) return "tap";
  return "cancel";
}
