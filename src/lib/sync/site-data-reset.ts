import { V7_DATABASE_NAME, dbV7 } from "../db/db-v7";
import { getPlatformEnvironment } from "../../platform/environment";
import { clearPersistentConfig } from "../../platform/persistent-config";
import { clearGitHubCredentials } from "./github-credentials";

function deleteCookie(name: string, path: string, domain?: string) {
  document.cookie = `${name}=; Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}${domain ? `; domain=${domain}` : ""}; SameSite=Lax`;
}

function clearSiteCookies() {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const names = document.cookie.split(";").map((item) => item.split("=")[0]?.trim()).filter(Boolean) as string[];
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const paths = new Set(["/", window.location.pathname]);
  pathParts.forEach((_, index) => {
    const path = `/${pathParts.slice(0, index + 1).join("/")}`;
    paths.add(path);
    paths.add(`${path}/`);
  });
  const domains = [undefined, window.location.hostname, `.${window.location.hostname}`];
  for (const name of names) {
    for (const path of paths) for (const domain of domains) deleteCookie(name, path, domain);
  }
}

function deleteIndexedDatabase(name: string) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`无法删除数据库 ${name}`));
    request.onblocked = () => reject(new Error("数据库正被其他页面使用，请关闭本站的其他标签页后重试。"));
  });
}

/**
 * localStorage keys that hold explicit user configuration and must survive a
 * "clear data, keep config" reset: practice preferences/theme, the GitHub
 * connection (repo + token), and this browser's device identity. Runtime state
 * (selected banks, search history) is treated as data and cleared.
 */
const CONFIG_LOCAL_STORAGE_KEYS = ["study-v7-preferences", "study-v6-preferences", "github-settings", "github-token", "shijuan-study-v7-device-id", "shijuan-study-v6-device-id"] as const;

/** Wipe service workers, caches, all IndexedDB databases and cookies. */
async function wipeServiceWorkersCachesDatabasesAndCookies() {
  const native = getPlatformEnvironment().native;
  // WKWebView does not register the PWA worker and its Cache API is not part
  // of the app's durable content contract; only Web/PWA clears these surfaces.
  if (!native) {
    const registrations = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistrations() : [];
    await Promise.all(registrations.map((registration) => registration.unregister()));
    if ("caches" in window) await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
  }

  dbV7.close();
  const databases = typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
  // The reset action is deliberately broader than normal v7 startup: it is
  // the one user-authorised path that also removes an abandoned legacy DB.
  const names = new Set([V7_DATABASE_NAME, "memory-line-study", ...databases.map((database) => database.name).filter(Boolean) as string[]]);
  await Promise.all([...names].map(deleteIndexedDatabase));

  if (!native) clearSiteCookies();
}

/** Clear every client-side persistence surface available to this origin. */
export async function clearAllSiteData() {
  await wipeServiceWorkersCachesDatabasesAndCookies();
  localStorage.clear();
  sessionStorage.clear();
  if (getPlatformEnvironment().native) {
    await clearGitHubCredentials();
    await clearPersistentConfig();
  }
}

/**
 * Clear all local content (题库、作答、练习、缓存、Cookie、运行时状态) but preserve
 * user configuration — practice preferences/theme and the GitHub connection —
 * so the user can immediately re-sync to repopulate the cleared content.
 */
export async function clearSiteDataExceptConfig() {
  const snapshot = new Map<string, string>();
  const native = getPlatformEnvironment().native;
  for (const key of CONFIG_LOCAL_STORAGE_KEYS) {
    if (native && key === "github-token") continue;
    const value = localStorage.getItem(key);
    if (value !== null) snapshot.set(key, value);
  }
  await wipeServiceWorkersCachesDatabasesAndCookies();
  localStorage.clear();
  sessionStorage.clear();
  for (const [key, value] of snapshot) localStorage.setItem(key, value);
}

export function reloadAsFreshSite() {
  window.location.replace(`${window.location.origin}${window.location.pathname}`);
}
