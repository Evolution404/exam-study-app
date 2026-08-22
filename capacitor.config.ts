import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.evolution404.shijuan",
  appName: "拾卷",
  webDir: "dist",
  plugins: {
    StatusBar: {
      overlaysWebView: true,
    },
  },
  // Capacitor 8 defaults to Swift Package Manager for a new iOS project.
  // Keep the config free of machine-specific signing or team identifiers.
};

export default config;
