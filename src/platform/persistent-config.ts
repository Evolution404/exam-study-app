import { Preferences } from "@capacitor/preferences";
import type { PlatformEnvironment } from "./environment";
import { getPlatformEnvironment } from "./environment";
import { GITHUB_RELAY_URL, GITHUB_WEB_RELAY_PATH } from "./github-transport";

export const PERSISTENT_CONFIG_KEYS = [
  "github-settings",
  "study-v7-preferences",
  "shijuan-study-v7-device-id",
] as const;

export type PersistentConfigKey = (typeof PERSISTENT_CONFIG_KEYS)[number];

export interface PersistentPreferencesBridge {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

let bridge: PersistentPreferencesBridge = Preferences;
const mirrors = new Map<string, string>();
let nativeEnabled = false;

function readLocal(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(key);
}

function writeLocal(key: string, value: string): void {
  mirrors.set(key, value);
  if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
}

export function setPersistentPreferencesBridge(next: PersistentPreferencesBridge): void {
  bridge = next;
}

export function isPersistentConfigNative(): boolean {
  return nativeEnabled;
}

export function getPersistentConfigMirror(key: string): string | null {
  return mirrors.get(key) ?? readLocal(key);
}

/**
 * Hydrate the small native durable mirror before React or the database starts.
 * Existing browser values are only copied to Preferences when a native value
 * does not exist; a user-configured endpoint is never overwritten by a
 * platform default.
 */
export async function hydratePersistentConfig(environment: PlatformEnvironment = getPlatformEnvironment()): Promise<void> {
  nativeEnabled = environment.native;
  if (!nativeEnabled) {
    for (const key of PERSISTENT_CONFIG_KEYS) {
      const value = readLocal(key);
      if (value !== null) mirrors.set(key, value);
    }
    return;
  }

  for (const key of PERSISTENT_CONFIG_KEYS) {
    const native = await bridge.get({ key });
    if (native.value !== null) {
      const value = migrateNativeConfigValue(key, native.value);
      writeLocal(key, value);
      if (value !== native.value) await bridge.set({ key, value });
      continue;
    }
    const local = readLocal(key);
    if (local !== null) {
      const value = migrateNativeConfigValue(key, local);
      await bridge.set({ key, value });
      mirrors.set(key, value);
      if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
    }
  }
}

function migrateNativeConfigValue(key: string, value: string): string {
  if (key !== "github-settings") return value;
  try {
    const parsed = JSON.parse(value) as { apiBaseUrl?: unknown };
    if (parsed.apiBaseUrl === GITHUB_WEB_RELAY_PATH) return JSON.stringify({ ...parsed, apiBaseUrl: GITHUB_RELAY_URL });
  } catch {
    // Preserve malformed settings for the normal settings loader to handle;
    // hydration must not destroy user data merely because it cannot parse it.
  }
  return value;
}

/** Persist a critical config value while keeping existing sync getters usable. */
export async function persistConfigValue(key: PersistentConfigKey, value: string): Promise<void> {
  writeLocal(key, value);
  if (!nativeEnabled) return;
  await bridge.set({ key, value });
}

/** Best-effort mirror used by synchronous device-id allocation. */
export function queueConfigMirror(key: PersistentConfigKey, value: string): void {
  writeLocal(key, value);
  if (nativeEnabled) void bridge.set({ key, value }).catch(() => undefined);
}

export async function clearPersistentConfig(): Promise<void> {
  if (nativeEnabled) {
    for (const key of PERSISTENT_CONFIG_KEYS) await bridge.remove({ key });
  }
  for (const key of PERSISTENT_CONFIG_KEYS) mirrors.delete(key);
}
