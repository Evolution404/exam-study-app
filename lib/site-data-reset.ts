import { db } from "./db";

function deleteCookie(name: string, path: string, domain?: string) {
  document.cookie = `${name}=; Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}${domain ? `; domain=${domain}` : ""}; SameSite=Lax`;
}

function clearSiteCookies() {
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

/** Clear every client-side persistence surface available to this origin. */
export async function clearAllSiteData() {
  const registrations = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistrations() : [];
  await Promise.all(registrations.map((registration) => registration.unregister()));
  if ("caches" in window) await Promise.all((await caches.keys()).map((key) => caches.delete(key)));

  db.close();
  const databases = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
  const names = new Set(["memory-line-study", ...databases.map((database) => database.name).filter(Boolean) as string[]]);
  await Promise.all([...names].map(deleteIndexedDatabase));

  localStorage.clear();
  sessionStorage.clear();
  clearSiteCookies();
}

export function reloadAsFreshSite() {
  window.location.replace(`${window.location.origin}${window.location.pathname}`);
}
