/**
 * Serialize sync, pull and restore operations.
 *
 * The in-module queue covers concurrent callers in one JS realm.  Browsers
 * that expose Web Locks extend the same critical section across tabs/workers;
 * tests and non-browser runtimes simply use the local queue.
 */
type NavigatorLocksLike = {
  request<T>(name: string, options: { mode: "exclusive" }, callback: () => Promise<T>): Promise<T>;
};

let lockTail: Promise<void> = Promise.resolve();

function browserLocks(): NavigatorLocksLike | undefined {
  const navigatorValue = (globalThis as { navigator?: { locks?: NavigatorLocksLike } }).navigator;
  return navigatorValue?.locks;
}
export async function withSyncLock<T>(operation: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = lockTail;
  lockTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const locks = browserLocks();
    if (locks) return await locks.request("shijuan-study-v7-sync", { mode: "exclusive" }, operation);
    return await operation();
  } finally {
    release();
  }
}
