import { useEffect, useRef, useState } from "react";
import type { SyncProgress } from "@/lib/sync/github-sync";

/**
 * Smooth out the sync progress bar.
 *
 * The sync layer now reports fine-grained, monotonic percents with a `to`
 * ceiling per phase, but individual steps (a multi-MB checkpoint download, a
 * big projection install) can still run for seconds between reports.  This hook
 * turns the discrete reports into a continuously moving value:
 *
 * - eases toward each new reported percent instead of snapping;
 * - when a step runs long, creeps asymptotically toward the phase's `to`
 *   ceiling so the bar keeps breathing but never claims to have finished;
 * - never moves backwards within a run (matching the backend's monotonic
 *   wrapper); a much smaller percent resets the run (a new dialog/operation).
 *
 * All state updates happen inside the ticker (never synchronously in an
 * effect), so reports only mutate refs and the next tick renders them.
 */
export function useSmoothProgress(progress: SyncProgress | undefined): SyncProgress | undefined {
  const [smoothed, setSmoothed] = useState<SyncProgress | undefined>(undefined);
  const latest = useRef<SyncProgress | undefined>(undefined);
  const lastLabel = useRef<string>("");
  const lastPercent = useRef<number>(-1);
  const displayed = useRef(0);
  const target = useRef(0);
  const ceiling = useRef(100);
  const reportedAt = useRef(0);

  useEffect(() => {
    if (!progress) {
      latest.current = undefined;
      return;
    }
    // A percent far below what is already displayed means a NEW run started
    // (restore after sync, retry across operations) — snap down to it.
    if (progress.percent + 15 < displayed.current) displayed.current = progress.percent;
    latest.current = progress;
    target.current = progress.percent;
    ceiling.current = progress.percent >= 100 ? 100 : Math.min(99, Math.max(progress.percent, progress.to ?? progress.percent + 8));
    reportedAt.current = Date.now();
  }, [progress]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const raw = latest.current;
      if (!raw) {
        if (lastPercent.current !== -1) {
          lastPercent.current = -1;
          lastLabel.current = "";
          displayed.current = 0;
          target.current = 0;
          ceiling.current = 100;
          setSmoothed(undefined);
        }
        return;
      }
      const previousRounded = Math.round(displayed.current);
      let value = displayed.current;
      value += (target.current - value) * 0.22;
      const stalled = Date.now() - reportedAt.current > 700;
      if (stalled && target.current < 100 && value < ceiling.current - 0.3) {
        value += Math.max(0.12, (ceiling.current - value) * 0.035);
      }
      if (target.current >= 100 && Math.abs(100 - value) < 0.5) value = 100;
      value = Math.min(value, ceiling.current);
      displayed.current = value;
      const next = Math.round(value);
      if (next !== previousRounded || raw.label !== lastLabel.current) {
        lastLabel.current = raw.label;
        lastPercent.current = next;
        setSmoothed({ ...raw, percent: next });
      }
    }, 80);
    return () => window.clearInterval(timer);
  }, []);

  return smoothed;
}
