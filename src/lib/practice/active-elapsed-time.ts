/**
 * Monotonic active-time accumulator used by the practice screen. UI code owns
 * the pause reasons (hidden document, overview/editor, submitted state); this
 * class only makes pause/resume/reset behavior deterministic and testable.
 */
export class ActiveElapsedTimer {
  private accumulatedMs = 0;
  private activeSinceMs: number | null;
  private lastNowMs: number;

  constructor(nowMs: number, active = true) {
    this.lastNowMs = nowMs;
    this.activeSinceMs = active ? nowMs : null;
  }

  private monotonicNow(nowMs: number) {
    this.lastNowMs = Math.max(this.lastNowMs, nowMs);
    return this.lastNowMs;
  }

  setPaused(paused: boolean, nowMs: number) {
    const now = this.monotonicNow(nowMs);
    if (paused) {
      if (this.activeSinceMs !== null) {
        this.accumulatedMs += Math.max(0, now - this.activeSinceMs);
        this.activeSinceMs = null;
      }
      return;
    }
    if (this.activeSinceMs === null) this.activeSinceMs = now;
  }

  reset(nowMs: number, paused = false) {
    const now = this.monotonicNow(nowMs);
    this.accumulatedMs = 0;
    this.activeSinceMs = paused ? null : now;
  }

  elapsedMs(nowMs: number) {
    const now = this.monotonicNow(nowMs);
    const runningMs = this.activeSinceMs === null ? 0 : Math.max(0, now - this.activeSinceMs);
    return Math.max(0, Math.round(this.accumulatedMs + runningMs));
  }
}
