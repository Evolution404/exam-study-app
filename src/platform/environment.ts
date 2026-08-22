import { Capacitor } from "@capacitor/core";

export type AppPlatform = "web" | "ios";

export interface PlatformEnvironment {
  platform: AppPlatform;
  native: boolean;
  ios: boolean;
}

/**
 * The small portion of Capacitor's runtime API used by the platform adapter.
 * Keeping this interface injectable lets source tests exercise platform
 * boundaries without manufacturing a WKWebView global.
 */
export interface CapacitorPlatformBridge {
  isNativePlatform(): boolean;
  getPlatform(): string;
}

export function detectPlatform(bridge: CapacitorPlatformBridge): PlatformEnvironment {
  const native = bridge.isNativePlatform();
  const ios = native && bridge.getPlatform().toLowerCase() === "ios";
  return { platform: ios ? "ios" : "web", native, ios };
}

export function getPlatformEnvironment(): PlatformEnvironment {
  return detectPlatform(Capacitor);
}

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export function isIOSApp(): boolean {
  return isNativeApp() && Capacitor.getPlatform().toLowerCase() === "ios";
}
