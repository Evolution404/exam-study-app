import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright-core";
import { startMockGitHubServer } from "../../tools/mock-github-server.mjs";
import { launchProjectChromium } from "../../tools/chrome-executable.mjs";

export { assert, path, chromium, webkit, startMockGitHubServer, launchProjectChromium };
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const headless = process.env.BROWSER_HEADLESS !== "0" && process.env.BROWSER_HEADLESS !== "false";
export const browserEngineName = process.env.BROWSER_ENGINE?.trim() || "chromium";
if (browserEngineName !== "chromium" && browserEngineName !== "webkit") {
  throw new Error(`BROWSER_ENGINE must be chromium or webkit, got ${browserEngineName}`);
}
const configuredBaseUrl = process.env.BASE_URL?.trim();
const configuredPort = process.env.BROWSER_PORT?.trim() || "5173";
const serverPort = Number(configuredPort);
if (!configuredBaseUrl && (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65_535)) {
  throw new Error(`BROWSER_PORT must be an integer between 1 and 65535, got ${configuredPort}`);
}
export const baseUrl = (configuredBaseUrl || `http://127.0.0.1:${serverPort}`).replace(/\/$/, "");
const artifactRoot = path.join(root, "artifacts", "browser-qa");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
export const runRoot = path.join(artifactRoot, runId);
export const screenshots = [];
export let devServer;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 30_000, processRef, isReady = () => true) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (processRef?.exitCode !== null) {
      throw new Error(`Development server exited before becoming ready (code ${processRef.exitCode ?? "signal"})`);
    }
    if (!isReady()) {
      await wait(100);
      continue;
    }
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? `: ${lastError.message}` : ""}`);
}

export async function startDevServerIfNeeded() {
  if (configuredBaseUrl) return;
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  let viteReady = false;
  devServer = spawn(npm, ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(serverPort), "--strictPort"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none" },
  });
  devServer.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    if (/Local:\s/.test(text)) viteReady = true;
    process.stdout.write(`[vite] ${text}`);
  });
  devServer.stderr?.on("data", (chunk) => process.stderr.write(`[vite] ${chunk}`));
  await waitForServer(`${baseUrl}/`, 30_000, devServer, () => viteReady);
}
