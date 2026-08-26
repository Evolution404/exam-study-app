import { registerPlugin } from "@capacitor/core";
import type { PlatformEnvironment } from "./environment";
import { getPlatformEnvironment } from "./environment";

export interface SecureCredentialsPlugin {
  get(options: { key: string }): Promise<{ value?: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

const SECURE_GITHUB_TOKEN_KEY = "github-token";

const registeredPlugin = registerPlugin<SecureCredentialsPlugin>("SecureCredentials");
let plugin: SecureCredentialsPlugin = registeredPlugin;
let nativeEnabled = false;
let hydrated = false;
let tokenCache = "";

export function setSecureCredentialsPlugin(next: SecureCredentialsPlugin): void {
  plugin = next;
}

export function isSecureCredentialsNative(environment: PlatformEnvironment = getPlatformEnvironment()): boolean {
  return nativeEnabled || (environment.native && environment.ios);
}

/** Load authoritative Keychain state before the React tree is mounted. */
export async function bootstrapSecureCredentials(environment: PlatformEnvironment = getPlatformEnvironment()): Promise<void> {
  nativeEnabled = isSecureCredentialsNative(environment);
  if (!nativeEnabled) {
    hydrated = true;
    tokenCache = "";
    return;
  }
  const result = await plugin.get({ key: SECURE_GITHUB_TOKEN_KEY });
  tokenCache = typeof result.value === "string" ? result.value : "";
  hydrated = true;
}

/** Synchronous credential read used after platform bootstrap. */
export function loadSecureCredential(key = SECURE_GITHUB_TOKEN_KEY): string {
  if (!nativeEnabled || key !== SECURE_GITHUB_TOKEN_KEY) return "";
  return hydrated ? tokenCache : "";
}

/** Update the in-memory value immediately, then persist it to Keychain. */
export async function saveSecureCredential(value: string, key = SECURE_GITHUB_TOKEN_KEY): Promise<void> {
  if (!nativeEnabled || key !== SECURE_GITHUB_TOKEN_KEY) return;
  const previous = tokenCache;
  tokenCache = value;
  try {
    if (value) await plugin.set({ key, value });
    else await plugin.remove({ key });
  } catch (error) {
    tokenCache = previous;
    throw error;
  }
}

export async function clearSecureCredentials(): Promise<void> {
  if (nativeEnabled) await plugin.remove({ key: SECURE_GITHUB_TOKEN_KEY });
  tokenCache = "";
  hydrated = nativeEnabled ? hydrated : true;
}

/** Test helper; production code should use the platform bootstrap. */
export function resetSecureCredentialsForTests(): void {
  plugin = registeredPlugin;
  nativeEnabled = false;
  hydrated = false;
  tokenCache = "";
}
