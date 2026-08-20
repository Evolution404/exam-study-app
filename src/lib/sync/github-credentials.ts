import type { GitHubSettings } from "../../types/types";

const settingsKey = "github-settings";
const tokenKey = "github-token";

/**
 * Cloudflare Pages 使用同源 Function。GitHub Pages 无法运行 Functions，
 * 因此自动使用配套的跨域 Worker；否则公开主站上的默认同步会稳定 404。
 * 用户仍可在同步页显式改为自己的中转地址。
 */
export const GITHUB_PAGES_RELAY = "https://sync.980923.xyz";

function currentHostname() {
  return typeof location !== "undefined" ? location.hostname : "";
}

export function resolveDefaultGitHubApiBaseUrl(hostname = currentHostname()) {
  return hostname.toLowerCase().endsWith(".github.io") ? GITHUB_PAGES_RELAY : "/api-github";
}

export const DEFAULT_GITHUB_SETTINGS: GitHubSettings = { owner: "", repo: "exam-study-vault", branch: "main", apiBaseUrl: resolveDefaultGitHubApiBaseUrl() };

export function loadGitHubSettings(): GitHubSettings {
  if (typeof window === "undefined") return DEFAULT_GITHUB_SETTINGS;
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as Partial<GitHubSettings>;
    const settings = { ...DEFAULT_GITHUB_SETTINGS, ...saved } as GitHubSettings;
    // Migrate the former same-origin default on GitHub Pages. It cannot be a
    // working intentional choice there because GitHub Pages serves static files only.
    if (resolveDefaultGitHubApiBaseUrl() === GITHUB_PAGES_RELAY && (!saved.apiBaseUrl || saved.apiBaseUrl === "/api-github")) settings.apiBaseUrl = GITHUB_PAGES_RELAY;
    return settings;
  } catch {
    return DEFAULT_GITHUB_SETTINGS;
  }
}

export function saveGitHubSettings(settings: GitHubSettings) {
  localStorage.setItem(settingsKey, JSON.stringify(settings));
}

export function loadGitHubToken() {
  if (typeof window === "undefined") return "";
  const persistent = localStorage.getItem(tokenKey);
  if (persistent !== null) return persistent;
  const previousSessionToken = sessionStorage.getItem(tokenKey) ?? "";
  if (previousSessionToken) localStorage.setItem(tokenKey, previousSessionToken);
  return previousSessionToken;
}

export function saveGitHubToken(token: string) {
  if (token) localStorage.setItem(tokenKey, token);
  else localStorage.removeItem(tokenKey);
  sessionStorage.removeItem(tokenKey);
}
