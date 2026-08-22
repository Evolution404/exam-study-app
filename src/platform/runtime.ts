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

async function syncNativeStatusBar(): Promise<void> {
  // Capacitor's iOS default is overlaying content. The app already accounts
  // for the safe areas in CSS, so keep that contract explicit and only let
  // native status-bar failures degrade to the regular web shell.
  await StatusBar.setOverlaysWebView({ overlay: true });
  await StatusBar.setStyle({ style: currentTheme() === "dark" ? Style.Light : Style.Dark });
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
    void StatusBar.setStyle({ style: currentTheme() === "dark" ? Style.Light : Style.Dark }).catch(() => undefined);
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

export const platformRuntime = {
  initialize(): Promise<PlatformEnvironment> {
    if (!initialized) {
      const environment = getPlatformEnvironment();
      initialized = (async () => {
        // Keep this order stable: synchronous legacy getters read mirrors after
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
