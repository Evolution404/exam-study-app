import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.evolution404.shijuan",
  appName: "拾卷",
  webDir: "dist",
  plugins: {
    StatusBar: {
      // Match Safari/PWA geometry; the web layer owns safe-area padding.
      overlaysWebView: true,
    },
  },
};

export default config;
