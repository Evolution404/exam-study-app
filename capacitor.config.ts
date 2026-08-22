import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.evolution404.shijuan",
  appName: "拾卷",
  webDir: "dist",
  plugins: {
    StatusBar: {
      // Keep the native status bar outside WKWebView, matching Safari's
      // content viewport. Set an explicit light-theme background so the
      // plugin's black default never appears during startup.
      overlaysWebView: false,
      backgroundColor: "#f3f0e9",
      style: "LIGHT",
    },
  },
};

export default config;
