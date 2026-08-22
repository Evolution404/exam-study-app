import type { GitHubSettings } from "../../types/types";
import { getPlatformEnvironment } from "../../platform/environment";
import { GITHUB_RELAY_URL, GITHUB_WEB_RELAY_PATH, resolveGitHubApiBaseUrl } from "../../platform/github-transport";
import { persistConfigValue } from "../../platform/persistent-config";
import { bootstrapSecureCredentials, clearSecureCredentials, isSecureCredentialsNative, loadSecureCredential, saveSecureCredential } from "../../platform/secure-credentials";

const settingsKey = "github-settings";
const tokenKey = "github-token";

/**
 * Cloudflare Pages 使用同源 Function。GitHub Pages 无法运行 Functions，
 * 因此自动使用配套的跨域 Worker；否则公开主站上的默认同步会稳定 404。
 * 用户仍可在同步页显式改为自己的中转地址。
 */
export const GITHUB_PAGES_RELAY = GITHUB_RELAY_URL;

function currentHostname() {
  return typeof location !== "undefined" ? location.hostname : "";
}

export function resolveDefaultGitHubApiBaseUrl(hostname = currentHostname(), environment = getPlatformEnvironment()) {
  if (environment.native) return GITHUB_PAGES_RELAY;
  return hostname.toLowerCase().endsWith(".github.io") ? GITHUB_PAGES_RELAY : GITHUB_WEB_RELAY_PATH;
}

export const DEFAULT_GITHUB_SETTINGS: GitHubSettings = { owner: "", repo: "exam-study-vault", branch: "main", apiBaseUrl: resolveDefaultGitHubApiBaseUrl() };

export function loadGitHubSettings(): GitHubSettings {
  if (typeof localStorage === "undefined") return DEFAULT_GITHUB_SETTINGS;
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as Partial<GitHubSettings>;
    const settings = { ...DEFAULT_GITHUB_SETTINGS, ...saved };
    if (settings.historySyncStart && !/^\d{4}-\d{2}-\d{2}$/.test(settings.historySyncStart)) delete settings.historySyncStart;
    const environment = getPlatformEnvironment();
    // Migrate only the former same-origin default. A user-provided relay or
    // diagnostic endpoint must remain untouched on native iOS.
    if (environment.native && saved.apiBaseUrl === GITHUB_WEB_RELAY_PATH) {
      settings.apiBaseUrl = GITHUB_PAGES_RELAY;
    } else if (!saved.apiBaseUrl) {
      settings.apiBaseUrl = resolveDefaultGitHubApiBaseUrl(currentHostname(), environment);
    }
    return settings;
  } catch {
    return { ...DEFAULT_GITHUB_SETTINGS };
  }
}

export function saveGitHubSettings(settings: GitHubSettings): Promise<void> {
  const normalized = { ...settings };
  if (!normalized.historySyncStart || !/^\d{4}-\d{2}-\d{2}$/.test(normalized.historySyncStart)) delete normalized.historySyncStart;
  localStorage.setItem(settingsKey, JSON.stringify(normalized));
  return persistConfigValue(settingsKey, JSON.stringify(normalized));
}

export function loadGitHubToken() {
  if (isSecureCredentialsNative()) return loadSecureCredential(tokenKey);
  if (typeof localStorage === "undefined") return "";
  const persistent = localStorage.getItem(tokenKey);
  if (persistent !== null) return persistent;
  const previousSessionToken = sessionStorage.getItem(tokenKey) ?? "";
  if (previousSessionToken) localStorage.setItem(tokenKey, previousSessionToken);
  return previousSessionToken;
}

export function saveGitHubToken(token: string): Promise<void> {
  if (isSecureCredentialsNative()) return saveSecureCredential(token, tokenKey);
  if (token) localStorage.setItem(tokenKey, token);
  else localStorage.removeItem(tokenKey);
  sessionStorage.removeItem(tokenKey);
  return Promise.resolve();
}

export function bootstrapGitHubCredentials(): Promise<void> {
  return bootstrapSecureCredentials(getPlatformEnvironment());
}

export function clearGitHubCredentials(): Promise<void> {
  return clearSecureCredentials();
}

/** Resolve configured or platform default endpoint for one sync call. */
export function resolveConfiguredGitHubApiBaseUrl(configured?: string): string {
  return resolveGitHubApiBaseUrl(configured);
}
