const PRACTICE_AUTO_RESUME_SUPPRESSION_KEY = "study-v7-practice-auto-resume-suppressed";

/**
 * Explicitly leaving practice should keep the user on the page they chose for
 * the rest of this browser/WKWebView session. The flag is intentionally stored
 * in sessionStorage: practiceRuns remains the only durable practice state.
 */
export function isPracticeAutoResumeSuppressed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(PRACTICE_AUTO_RESUME_SUPPRESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function suppressPracticeAutoResumeForSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(PRACTICE_AUTO_RESUME_SUPPRESSION_KEY, "1");
  } catch {
    // Losing this launch-scoped preference must never affect practice data.
  }
}

export function allowPracticeAutoResumeForSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PRACTICE_AUTO_RESUME_SUPPRESSION_KEY);
  } catch {
    // practiceRuns remains the source of truth even if sessionStorage is blocked.
  }
}
