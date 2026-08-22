import { Capacitor, registerPlugin } from "@capacitor/core";
import type { PlatformEnvironment } from "./environment";
import { getPlatformEnvironment } from "./environment";

export interface SecureCredentialsPlugin {
  get(options: { key: string }): Promise<{ value?: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

export const SECURE_GITHUB_TOKEN_KEY = "github-token";

const registeredPlugin = registerPlugin<SecureCredentialsPlugin>("SecureCredentials");
let plugin: SecureCredentialsPlugin = registeredPlugin;
let nativeEnabled = false;
let hydrated = false;
let tokenCache = "";

function legacyToken(): string {
  if (typeof localStorage !== "undefined") return localStorage.getItem(SECURE_GITHUB_TOKEN_KEY) ?? "";
  return "";
}

function legacySessionToken(): string {
  if (typeof sessionStorage !== "undefined") return sessionStorage.getItem(SECURE_GITHUB_TOKEN_KEY) ?? "";
  return "";
}

function removeLegacyToken(): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(SECURE_GITHUB_TOKEN_KEY);
  if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(SECURE_GITHUB_TOKEN_KEY);
}

export function setSecureCredentialsPlugin(next: SecureCredentialsPlugin): void {
  plugin = next;
}

export function isSecureCredentialsNative(environment: PlatformEnvironment = getPlatformEnvironment()): boolean {
  return nativeEnabled || (environment.native && environment.ios);
}

/**
 * Load Keychain state before the React tree is mounted. On native, a legacy
 * localStorage token is removed only after a successful Keychain write; failed
 * migration leaves the old value intact and surfaces the failure to bootstrap.
 */
export async function bootstrapSecureCredentials(environment: PlatformEnvironment = getPlatformEnvironment()): Promise<void> {
  nativeEnabled = isSecureCredentialsNative(environment);
  if (!nativeEnabled) {
    hydrated = true;
    tokenCache = "";
    return;
  }

  const result = await plugin.get({ key: SECURE_GITHUB_TOKEN_KEY });
  const stored = typeof result.value === "string" ? result.value : "";
  if (stored) {
    tokenCache = stored;
    // A development build may have written the token to WebKit storage before
    // the Keychain plugin was installed. Once Keychain is authoritative, erase
    // those stale copies as part of bootstrap.
    removeLegacyToken();
  } else {
    const oldToken = legacyToken() || legacySessionToken();
    if (oldToken) {
      await plugin.set({ key: SECURE_GITHUB_TOKEN_KEY, value: oldToken });
      removeLegacyToken();
      tokenCache = oldToken;
    } else {
      tokenCache = "";
    }
  }
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
    removeLegacyToken();
  } catch (error) {
    tokenCache = previous;
    throw error;
  }
}

export async function clearSecureCredentials(): Promise<void> {
  if (nativeEnabled) await plugin.remove({ key: SECURE_GITHUB_TOKEN_KEY });
  tokenCache = "";
  hydrated = nativeEnabled ? hydrated : true;
  if (!nativeEnabled) removeLegacyToken();
}

/** Test helper; production code should use the platform bootstrap. */
export function resetSecureCredentialsForTests(): void {
  plugin = registeredPlugin;
  nativeEnabled = false;
  hydrated = false;
  tokenCache = "";
}

// Keep Capacitor in this module's implementation boundary; no caller needs to
// inspect a native global or know how plugin availability is determined.
export function secureCredentialsPluginAvailable(): boolean {
  return Capacitor.isPluginAvailable("SecureCredentials");
}
