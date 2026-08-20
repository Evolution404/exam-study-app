import { syncApplication, type SyncProgressCallback, type SyncRunResult } from "./sync-application";

export interface AutomaticSyncOptions {
  enabled: boolean;
  pending: number;
  threshold: number;
  blocked?: boolean;
  debounceMs?: number;
  minimumIntervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface PeriodicPullOptions {
  enabled: boolean;
  seconds: number;
  blocked?: () => boolean;
  onError?: (error: unknown) => void;
}

class SyncRuntime {
  private inFlight: Promise<SyncRunResult> | null = null;
  private lastAutomaticSyncAt = 0;

  isBusy(): boolean {
    return this.inFlight !== null;
  }

  private run(operation: () => Promise<SyncRunResult>): Promise<SyncRunResult> {
    if (this.inFlight) return this.inFlight;
    const request = operation();
    this.inFlight = request;
    return request.finally(() => {
      if (this.inFlight === request) this.inFlight = null;
    });
  }

  sync(callback?: SyncProgressCallback): Promise<SyncRunResult> {
    return this.run(() => syncApplication.syncNow(callback));
  }

  pull(callback?: SyncProgressCallback): Promise<SyncRunResult> {
    return this.run(() => syncApplication.pullNow(callback));
  }

  scheduleAutomaticSync(options: AutomaticSyncOptions): () => void {
    const debounceMs = options.debounceMs ?? 2_500;
    const minimumIntervalMs = options.minimumIntervalMs ?? 30_000;
    const connection = syncApplication.getConnection();
    if (!options.enabled || options.blocked || options.pending < options.threshold || this.isBusy() || !connection.ready || Date.now() - this.lastAutomaticSyncAt < minimumIntervalMs) {
      return () => undefined;
    }

    let idleHandle: number | undefined;
    let cancelled = false;
    const execute = () => {
      if (cancelled || this.isBusy()) return;
      this.lastAutomaticSyncAt = Date.now();
      void this.sync().catch((error) => options.onError?.(error));
    };
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      if (typeof requestIdleCallback === "function") idleHandle = requestIdleCallback(execute, { timeout: 2_000 });
      else execute();
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (idleHandle !== undefined && typeof cancelIdleCallback === "function") cancelIdleCallback(idleHandle);
    };
  }

  startPeriodicPull(options: PeriodicPullOptions): () => void {
    if (!options.enabled) return () => undefined;
    const intervalMs = Math.max(1, options.seconds) * 1_000;
    const execute = async () => {
      if (options.blocked?.() || this.isBusy() || !syncApplication.getConnection().ready) return;
      try {
        await this.pull();
      } catch (error) {
        options.onError?.(error);
      }
    };
    const timer = window.setInterval(() => void execute(), intervalMs);
    return () => window.clearInterval(timer);
  }
}

export const syncRuntime = new SyncRuntime();
