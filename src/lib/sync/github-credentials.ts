import type { GitHubSettings } from "../../types/types";

const settingsKey = "github-settings";
const tokenKey = "github-token";

/**
 * 同步默认走应用同源的 GitHub 代理（Cloudflare Pages Function，源码见
 * proxy/pages-function.js，构建时生成 functions/api-github/[[path]].js）：
 * 同源请求不触发 CORS preflight。需要直连或外部中转时，在同步页把
 * 「同步中转地址」改成完整 URL 即可。
 */
export const DEFAULT_GITHUB_SETTINGS: GitHubSettings = { owner: "", repo: "exam-study-vault", branch: "main", apiBaseUrl: "/api-github" };

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
