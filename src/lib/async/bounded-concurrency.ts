export interface BoundedConcurrencyOptions {
  /** Stop claiming new work when the signal is aborted. */
  signal?: AbortSignal;
}

type BoundedConcurrencyOptionsInput = BoundedConcurrencyOptions | AbortSignal | undefined;

function optionsSignal(options: BoundedConcurrencyOptionsInput): AbortSignal | undefined {
  if (!options) return undefined;
  if (typeof AbortSignal !== "undefined" && options instanceof AbortSignal) return options;
  return (options as BoundedConcurrencyOptions).signal;
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  if (typeof DOMException !== "undefined") return new DOMException("The operation was aborted", "AbortError");
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Run async work through a bounded number of lanes while preserving input
 * order.  A worker receives the shared AbortSignal as its third argument.  If
 * a worker fails, no lane claims another item after that failure is observed;
 * already-running workers are awaited so their rejected promises cannot leak.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number, signal: AbortSignal | undefined) => Promise<R>,
  options?: BoundedConcurrencyOptionsInput,
): Promise<R[]> {
  if (!Number.isFinite(limit) || limit <= 0) throw new RangeError("并发数量必须是正数。");
  if (!items.length) return [];
  const signal = optionsSignal(options);
  if (signal?.aborted) throw abortReason(signal);

  const results = new Array<R>(items.length);
  let next = 0;
  let stopped = false;
  let hasError = false;
  let firstError: unknown;
  const stop = () => { stopped = true; };
  signal?.addEventListener("abort", stop, { once: true });
  const run = async (): Promise<void> => {
    while (!stopped && !signal?.aborted) {
      const index = next;
      if (index >= items.length) return;
      next += 1;
      try {
        results[index] = await worker(items[index], index, signal);
      } catch (error) {
        if (!hasError) firstError = error;
        hasError = true;
        stopped = true;
        return;
      }
    }
  };
  const lanes = Math.min(Math.floor(limit), items.length);
  await Promise.all(Array.from({ length: lanes }, run));
  signal?.removeEventListener("abort", stop);
  if (hasError) throw firstError ?? new Error("并发任务执行失败。");
  if (signal?.aborted) throw abortReason(signal);
  return results;
}
