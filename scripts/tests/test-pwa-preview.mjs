import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { resolveChromeExecutable } from "../tools/chrome-executable.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const portText = process.env.PWA_PREVIEW_PORT?.trim() || "4173";
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`PWA_PREVIEW_PORT must be an integer between 1 and 65535, got ${portText}`);
}
const configuredBaseUrl = process.env.PWA_BASE_URL?.trim();
const baseUrl = (configuredBaseUrl || `http://127.0.0.1:${port}`).replace(/\/$/, "");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let previewServer;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probePreview(url) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("https:") ? https : http;
    const request = transport.get(url, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.setTimeout(2_000, () => request.destroy(new Error("preview probe timed out")));
    request.once("error", reject);
  });
}

async function waitForPreview(url, child) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite preview exited before becoming ready (code ${child.exitCode ?? "signal"})`);
    try {
      // Use Node's direct HTTP client instead of fetch. Some CI runners expose
      // proxy variables that can make loopback fetches return the proxy's 4xx
      // response even though the preview process is healthy.
      const status = await probePreview(url);
      if (status >= 200 && status < 400) return;
      lastError = new Error(`preview returned HTTP ${status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for Vite preview at ${url}${lastError ? `: ${lastError.message}` : ""}`);
}

async function buildIfNeeded() {
  if (process.env.PWA_SKIP_BUILD === "1" && existsSync(path.join(root, "dist", "index.html"))) return;
  await new Promise((resolve, reject) => {
    const child = spawn(npm, ["run", "build"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CF_PAGES: "1" },
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`npm run build exited with code ${code}`)));
  });
}

async function runSmoke() {
  await buildIfNeeded();
  previewServer = spawn(npm, ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none", CF_PAGES: "1" },
  });
  previewServer.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`[vite-preview] ${text}`);
  });
  previewServer.stderr?.on("data", (chunk) => process.stderr.write(`[vite-preview] ${chunk}`));
  await waitForPreview(`${baseUrl}/`, previewServer);

  const browser = await chromium.launch({
    executablePath: resolveChromeExecutable(),
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => navigator.serviceWorker.ready.then((registration) => Boolean(registration.active)), null, { timeout: 15_000 });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15_000 });
    const smoke = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const cacheNames = await caches.keys();
      const swResponse = await fetch(new URL("sw.js", window.location.href), { cache: "no-store" });
      const swText = await swResponse.text();
      const baseResponse = await caches.match(new URL("./", window.location.href).toString());
      return {
        controller: Boolean(navigator.serviceWorker.controller),
        activeScript: registration.active?.scriptURL ?? "",
        cacheNames,
        swOk: swResponse.ok,
        swVersioned: /shijuan-v10/.test(swText),
        baseCached: Boolean(baseResponse),
      };
    });
    assert.equal(smoke.controller, true, "preview page must be controlled by the service worker after reload");
    assert.match(smoke.activeScript, /\/sw\.js(?:\?.*)?$/, "active worker must be the deployed sw.js");
    assert.ok(smoke.cacheNames.includes("shijuan-v10"), "production worker must install the expected versioned cache");
    assert.equal(smoke.swOk, true, "preview must serve sw.js");
    assert.equal(smoke.swVersioned, true, "preview must serve the versioned service worker source");
    assert.equal(smoke.baseCached, true, "service worker install must cache the app shell");
    await context.close();
  } finally {
    await browser.close();
  }
}

try {
  await runSmoke();
  console.log(`PWA preview smoke passed at ${baseUrl}: production build served and sw.js controlled the page`);
} finally {
  if (previewServer && !previewServer.killed) previewServer.kill("SIGTERM");
}
