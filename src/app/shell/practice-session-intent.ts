const ACTIVE_PRACTICE_INTENT_KEY = "study-v7-active-practice";

export interface ActivePracticeIntent {
  runId: string;
  currentIndex: number;
}

export function loadActivePracticeIntent(): ActivePracticeIntent | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const value = JSON.parse(window.localStorage.getItem(ACTIVE_PRACTICE_INTENT_KEY) ?? "null") as unknown;
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as Partial<ActivePracticeIntent>;
    if (typeof candidate.runId !== "string" || !candidate.runId) return undefined;
    if (!Number.isSafeInteger(candidate.currentIndex) || (candidate.currentIndex ?? -1) < 0) return undefined;
    return { runId: candidate.runId, currentIndex: candidate.currentIndex! };
  } catch {
    return undefined;
  }
}

export function saveActivePracticeIntent(intent: ActivePracticeIntent): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTIVE_PRACTICE_INTENT_KEY, JSON.stringify(intent));
  } catch {
    // UI recovery intent is best-effort. PracticeRun remains the persisted
    // source of truth even when storage is unavailable or quota-limited.
  }
}

export function clearActivePracticeIntent(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ACTIVE_PRACTICE_INTENT_KEY);
  } catch {
    // Nothing else should fail merely because the local UI hint cannot clear.
  }
}
