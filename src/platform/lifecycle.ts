import { App, type AppState } from "@capacitor/app";
import type { PlatformEnvironment } from "./environment";
import { getPlatformEnvironment } from "./environment";
import { syncRuntime } from "../lib/sync/sync-runtime";

export interface AppLifecycleBridge {
  addListener(eventName: "appStateChange", listener: (state: AppState) => void): Promise<{ remove: () => Promise<void> }>;
  getState?: () => Promise<AppState>;
}

let listener: { remove: () => Promise<void> } | undefined;

/** Attach native app-state events once the platform bootstrap is complete. */
export async function initializeLifecycle(
  environment: PlatformEnvironment = getPlatformEnvironment(),
  app: AppLifecycleBridge = App,
): Promise<void> {
  if (!environment.ios) return;
  await shutdownLifecycle();
  syncRuntime.setAppActive(true);
  listener = await app.addListener("appStateChange", (state) => {
    syncRuntime.setAppActive(Boolean(state.isActive));
  });
  if (app.getState) {
    try {
      const state = await app.getState();
      syncRuntime.setAppActive(Boolean(state.isActive));
    } catch {
      // The initial native state is active by default; an event will correct it.
    }
  }
}

export async function shutdownLifecycle(): Promise<void> {
  const current = listener;
  listener = undefined;
  if (current) await current.remove();
  syncRuntime.setAppActive(true);
}

export function lifecycleListenerAttached(): boolean {
  return listener !== undefined;
}
