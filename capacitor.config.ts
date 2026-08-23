import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.evolution404.shijuan",
  appName: "拾卷",
  webDir: "dist",
  plugins: {
    StatusBar: {
      // Keep the native status bar outside WKWebView. The initial native theme
      // is resolved from Capacitor Preferences in Swift before the window is
      // shown, so this static plugin pass must not repaint it as light mode.
      overlaysWebView: false,
      backgroundColor: "#00000000",
      style: "DEFAULT",
    },
  },
};

export default config;
