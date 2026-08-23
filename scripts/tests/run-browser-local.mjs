import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const configuredBaseUrl = process.env.BASE_URL?.trim();
const portText = process.env.BROWSER_PORT?.trim() || "5173";
const port = Number(portText);
if (!configuredBaseUrl && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
  throw new Error(`BROWSER_PORT must be an integer between 1 and 65535, got ${portText}`);
}

function cleanBrowserEnv(source = process.env) {
  const env = { ...source };
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NODE_USE_ENV_PROXY",
  ]) {
    delete env[key];
  }

  const inheritedNoProxy = (env.NO_PROXY || env.no_proxy || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const noProxy = [...new Set([...inheritedNoProxy, "127.0.0.1", "localhost", "::1"])].join(",");
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  return env;
}

const env = cleanBrowserEnv();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const viteCli = path.join(root, "node_modules", "vite", "bin", "vite.js");
const harnessPath = fileURLToPath(new URL("./test-browser-visible.mjs", import.meta.url));
let viteServer;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeServer(url) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("https:") ? https : http;
    const request = transport.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        if (body.length < 2_000) body += chunk.slice(0, 2_000 - body.length);
      });
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.setTimeout(2_000, () => request.destroy(new Error("browser QA server probe timed out")));
    request.once("error", reject);
  });
}

async function waitForServer(url, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "no response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite exited before browser QA became ready (code ${child.exitCode ?? "signal"})`);
    }
    try {
      const result = await probeServer(url);
      if (result.status >= 200 && result.status < 400) return;
      const compactBody = result.body.replace(/\s+/g, " ").trim().slice(0, 500);
      lastDetail = `HTTP ${result.status}${compactBody ? `: ${compactBody}` : ""}`;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for browser QA Vite server at ${url}: ${lastDetail}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), wait(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function runHarness(baseUrl) {
  const child = spawn(process.execPath, [harnessPath], {
    cwd: root,
    stdio: "inherit",
    env: { ...env, BASE_URL: baseUrl },
  });
  const [code, signal] = await once(child, "exit");
  if (signal) throw new Error(`browser harness terminated by ${signal}`);
  if (code !== 0) throw new Error(`browser harness exited with code ${code}`);
}

try {
  if (configuredBaseUrl) {
    await runHarness(configuredBaseUrl.replace(/\/$/, ""));
  } else {
    // Keep local/CI runs self-contained: generate the title font before Vite,
    // then start Vite directly so cleanup cannot leave an npm grandchild alive.
    const predev = spawnSync(npm, ["run", "predev"], {
      cwd: root,
      stdio: "inherit",
      env,
    });
    if (predev.error) throw predev.error;
    if (predev.status !== 0) throw new Error(`npm run predev exited with code ${predev.status}`);

    viteServer = spawn(process.execPath, [viteCli, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, BROWSER: "none" },
    });
    viteServer.stdout?.on("data", (chunk) => process.stdout.write(`[vite] ${chunk}`));
    viteServer.stderr?.on("data", (chunk) => process.stderr.write(`[vite] ${chunk}`));

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(`${baseUrl}/`, viteServer);
    console.log(`[browser-qa] Vite ready at ${baseUrl}/ via direct HTTP probe`);
    await runHarness(baseUrl);
  }
} finally {
  await stopChild(viteServer);
}
