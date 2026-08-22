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
  private appActive = true;
  private periodicPull: { options: PeriodicPullOptions; timer?: ReturnType<typeof setInterval> } | null = null;
  private lastPeriodicPullAt = 0;

  isBusy(): boolean {
    return this.inFlight !== null;
  }

  isAppActive(): boolean {
    return this.appActive;
  }

  /** Called by the native App lifecycle adapter. */
  setAppActive(active: boolean): void {
    if (this.appActive === active) return;
    this.appActive = active;
    if (!active) {
      this.stopPeriodicTimer();
      return;
    }
    this.startPeriodicTimer();
    const periodic = this.periodicPull;
    if (periodic && periodic.options.enabled && Date.now() - this.lastPeriodicPullAt >= Math.max(1, periodic.options.seconds) * 1_000) {
      void this.executePeriodicPull(periodic.options);
    }
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
      if (cancelled || !this.appActive || this.isBusy()) return;
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
    this.stopPeriodicTimer();
    this.periodicPull = options.enabled ? { options } : null;
    if (options.enabled && this.lastPeriodicPullAt === 0) this.lastPeriodicPullAt = Date.now();
    this.startPeriodicTimer();
    const current = this.periodicPull;
    return () => {
      if (this.periodicPull !== current) return;
      this.stopPeriodicTimer();
      this.periodicPull = null;
    };
  }

  private stopPeriodicTimer(): void {
    const timer = this.periodicPull?.timer;
    if (timer !== undefined) clearInterval(timer);
    if (this.periodicPull) this.periodicPull.timer = undefined;
  }

  private startPeriodicTimer(): void {
    const periodic = this.periodicPull;
    if (!periodic || !periodic.options.enabled || !this.appActive || periodic.timer !== undefined) return;
    const intervalMs = Math.max(1, periodic.options.seconds) * 1_000;
    periodic.timer = setInterval(() => void this.executePeriodicPull(periodic.options), intervalMs);
  }

  private async executePeriodicPull(options: PeriodicPullOptions): Promise<void> {
    if (!this.appActive || options.blocked?.() || this.isBusy() || !syncApplication.getConnection().ready) return;
    this.lastPeriodicPullAt = Date.now();
    try {
      await this.pull();
    } catch (error) {
      options.onError?.(error);
    }
  }
}

export const syncRuntime = new SyncRuntime();
