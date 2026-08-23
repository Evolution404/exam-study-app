import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const env = { ...process.env };

// Browser QA only talks to local Vite/mock servers. Some CI runners and local
// proxy tools inject HTTP(S)_PROXY/ALL_PROXY variables; recent Node fetch
// configurations can then route 127.0.0.1 through that proxy and turn a
// healthy Vite server into a synthetic 4xx/5xx readiness response.
// Start the actual browser harness in a clean child process so Node's global
// dispatcher is initialized without proxy configuration. This does not alter
// application transport behavior or browser proxy settings in production.
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

const child = spawn(process.execPath, [fileURLToPath(new URL("./test-browser-visible.mjs", import.meta.url))], {
  stdio: "inherit",
  env,
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`browser harness terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
