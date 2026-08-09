import type { GitHubSettings } from "./types";

const settingsKey = "github-settings";
const tokenKey = "github-token";

export const DEFAULT_GITHUB_SETTINGS: GitHubSettings = { owner: "", repo: "exam-study-vault", branch: "main" };

export function loadGitHubSettings(): GitHubSettings {
  if (typeof window === "undefined") return DEFAULT_GITHUB_SETTINGS;
  try {
    return { ...DEFAULT_GITHUB_SETTINGS, ...JSON.parse(localStorage.getItem(settingsKey) ?? "{}") } as GitHubSettings;
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
