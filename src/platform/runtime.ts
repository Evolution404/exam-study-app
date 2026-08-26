import { StatusBar, Style } from "@capacitor/status-bar";
import type { PlatformEnvironment } from "./environment";
import { getPlatformEnvironment } from "./environment";
import { bootstrapSecureCredentials } from "./secure-credentials";
import { hydratePersistentConfig } from "./persistent-config";
import { initializeLifecycle } from "./lifecycle";

export interface ServiceWorkerContainerLike {
  register(scriptURL: string, options?: RegistrationOptions): Promise<ServiceWorkerRegistration>;
}

let initialized: Promise<PlatformEnvironment> | undefined;
let themeObserver: MutationObserver | undefined;

function currentTheme(): "light" | "dark" {
  if (typeof document !== "undefined" && document.documentElement.dataset.theme === "dark") return "dark";
  return "light";
}

function currentStatusBarStyle() {
  // Capacitor names these styles by the background they are intended for:
  // Style.Dark = light content on a dark background;
  // Style.Light = dark content on a light background.
  return currentTheme() === "dark" ? Style.Dark : Style.Light;
}

function currentStatusBarBackgroundColor() {
  return currentTheme() === "dark" ? "#101612" : "#f3f0e9";
}

async function syncNativeStatusBarAppearance(): Promise<void> {
  await StatusBar.setBackgroundColor({ color: currentStatusBarBackgroundColor() });
  await StatusBar.setStyle({ style: currentStatusBarStyle() });
}

async function syncNativeStatusBar(): Promise<void> {
  // Match Safari's content viewport: the native status bar owns its area and
  // WKWebView begins below it. Its background follows the app theme instead of
  // exposing the StatusBar plugin's black default.
  await StatusBar.show();
  await StatusBar.setBackgroundColor({ color: currentStatusBarBackgroundColor() });
  await StatusBar.setOverlaysWebView({ overlay: false });
  await StatusBar.setStyle({ style: currentStatusBarStyle() });
}

async function initializeNativeRuntime(environment: PlatformEnvironment): Promise<void> {
  if (!environment.ios) return;
  try {
    await syncNativeStatusBar();
  } catch {
    // The web layer must remain usable if a plugin is unavailable during a
    // development build or while Xcode is refreshing the native project.
  }

  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  themeObserver?.disconnect();
  themeObserver = new MutationObserver(() => {
    void syncNativeStatusBarAppearance().catch(() => undefined);
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

export const platformRuntime = {
  initialize(): Promise<PlatformEnvironment> {
    if (!initialized) {
      const environment = getPlatformEnvironment();
      initialized = (async () => {
        // Keep this order stable: synchronous config getters read mirrors after
        // Preferences/Keychain hydration, and lifecycle timers must not start
        // until both credential and config bootstraps have completed.
        await hydratePersistentConfig(environment);
        await bootstrapSecureCredentials(environment);
        await initializeLifecycle(environment);
        await initializeNativeRuntime(environment);
        return environment;
      })();
    }
    return initialized;
  },
};

export function shouldRegisterServiceWorker(production: boolean, environment: PlatformEnvironment): boolean {
  return production && !environment.native;
}

/**
 * Register PWA caching only for the browser build. Native WKWebView does not
 * need (and must not create) a Service Worker registration.
 */
export async function registerServiceWorker(
  production: boolean,
  environment = getPlatformEnvironment(),
  scriptUrl = "sw.js",
  serviceWorker: ServiceWorkerContainerLike | undefined = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined,
): Promise<ServiceWorkerRegistration | undefined> {
  if (!shouldRegisterServiceWorker(production, environment) || !serviceWorker) return undefined;
  try {
    return await serviceWorker.register(scriptUrl, { updateViaCache: "none" });
  } catch {
    return undefined;
  }
}
