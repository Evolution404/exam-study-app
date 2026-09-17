const PRACTICE_AUTO_RESUME_SUPPRESSION_KEY = "study-practice-auto-resume-suppressed-run-id";

/**
 * Explicitly leaving a specific practice run is a device-local navigation
 * preference, not practice progress. Persist only that run id so a cold browser
 * or WKWebView restart does not immediately force the user back into a run they
 * deliberately paused. `practiceRuns` remains the only durable source for
 * questions, answers and progress.
 */
export function isPracticeAutoResumeSuppressed(runId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PRACTICE_AUTO_RESUME_SUPPRESSION_KEY) === runId;
  } catch {
    return false;
  }
}

export function suppressPracticeAutoResumeForRun(runId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PRACTICE_AUTO_RESUME_SUPPRESSION_KEY, runId);
  } catch {
    // Losing this local UI preference must never affect practice data.
  }
}

export function allowPracticeAutoResumeForRun(runId?: string): void {
  if (typeof window === "undefined") return;
  try {
    const suppressed = window.localStorage.getItem(PRACTICE_AUTO_RESUME_SUPPRESSION_KEY);
    if (!runId || suppressed === runId) window.localStorage.removeItem(PRACTICE_AUTO_RESUME_SUPPRESSION_KEY);
  } catch {
    // practiceRuns remains the source of truth even if localStorage is blocked.
  }
}
