import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.evolution404.shijuan",
  appName: "拾卷",
  webDir: "dist",
  plugins: {
    StatusBar: {
      // Match mobile Safari geometry: keep the WKWebView below the iOS
      // status bar instead of drawing page content underneath it.
      overlaysWebView: false,
    },
  },
  // Capacitor 8 defaults to Swift Package Manager for a new iOS project.
  // Keep the config free of machine-specific signing or team identifiers.
};

export default config;
