import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Resolve a system Chromium/Chrome executable for Playwright-core.
 *
 * playwright-core intentionally does not download a browser. Keep the
 * override for local/CI installations, then use platform-specific well-known
 * paths and PATH lookup so browser smoke tests do not depend on a macOS path.
 */
export function resolveChromeExecutable() {
  const configured = process.env.CHROME_PATH?.trim();
  if (configured) {
    if (existsSync(configured)) return configured;
    throw new Error(`CHROME_PATH does not exist: ${configured}`);
  }

  const candidates = process.platform === "darwin"
    ? [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "google-chrome",
      "chromium",
    ]
    : process.platform === "win32"
      ? [
        process.env.PROGRAMFILES ? `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe` : "",
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : "",
        "chrome.exe",
        "msedge.exe",
      ]
      : ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];

  for (const candidate of candidates.filter(Boolean)) {
    if (existsSync(candidate)) return candidate;
    if (candidate.includes("/") || candidate.includes("\\")) continue;
    const lookup = spawnSync(process.platform === "win32" ? "where" : "which", [candidate], { encoding: "utf8" });
    if (lookup.status === 0) {
      const executable = lookup.stdout.trim().split(/\r?\n/)[0];
      if (executable && existsSync(executable)) return executable;
    }
  }

  throw new Error("No Chrome/Chromium executable found. Install Chromium or set CHROME_PATH to its executable path.");
}
