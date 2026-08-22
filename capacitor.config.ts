import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.evolution404.shijuan",
  appName: "拾卷",
  webDir: "dist",
  // Keep WKWebView edge-to-edge behavior identical to Safari.
  // Safe area is handled by the web layer through viewport-fit and env().
  // Do not let StatusBar plugin resize the WebView frame.
};

export default config;
