import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { IOS_BUNDLE_ID, SIDESTORE_IPA_URL, SIDESTORE_SOURCE_URL } from "./generate-sidestore-source.mjs";

function readArg(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少参数`);
  return value;
}

export function validatePublishedSource(source, expectedVersion) {
  const app = source?.apps?.find((candidate) => candidate?.bundleIdentifier === IOS_BUNDLE_ID);
  if (!app) throw new Error(`更新源缺少 ${IOS_BUNDLE_ID}`);
  const latest = app.versions?.[0];
  if (latest?.version !== expectedVersion) {
    throw new Error(`线上版本尚未更新：期望 ${expectedVersion}，实际 ${latest?.version ?? "缺失"}`);
  }
  if (latest.downloadURL !== SIDESTORE_IPA_URL || app.downloadURL !== SIDESTORE_IPA_URL) {
    throw new Error("更新源没有使用 Cloudflare IPA 代理地址");
  }
  if (!Number.isSafeInteger(latest.size) || latest.size <= 0) throw new Error("更新源 IPA 大小无效");
  return latest;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function verifyRelease({ version, attempts = 30, intervalMs = 5000, fetchImpl = fetch }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const sourceResponse = await fetchImpl(`${SIDESTORE_SOURCE_URL}?release=${encodeURIComponent(version)}-${Date.now()}`, {
        headers: { "cache-control": "no-cache", accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!sourceResponse.ok) throw new Error(`更新源 HTTP ${sourceResponse.status}`);
      const latest = validatePublishedSource(await sourceResponse.json(), version);

      const ipaResponse = await fetchImpl(`${SIDESTORE_IPA_URL}?release=${encodeURIComponent(version)}-${Date.now()}`, {
        method: "HEAD",
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(15000),
      });
      if (!ipaResponse.ok) throw new Error(`IPA HTTP ${ipaResponse.status}`);
      const contentLength = Number(ipaResponse.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== latest.size) {
        throw new Error(`IPA 大小不一致：更新源 ${latest.size}，代理 ${contentLength}`);
      }
      console.log(`SideStore 线上验证通过：${SIDESTORE_SOURCE_URL}（${version}）`);
      return;
    } catch (error) {
      lastError = error;
      console.log(`等待 SideStore 代理更新（${attempt}/${attempts}）：${error instanceof Error ? error.message : String(error)}`);
      if (attempt < attempts) await delay(intervalMs);
    }
  }
  throw lastError;
}

export async function run(argv = process.argv.slice(2)) {
  const version = readArg(argv, "--version");
  const attempts = Number(readArg(argv, "--attempts", "30"));
  const intervalMs = Number(readArg(argv, "--interval-ms", "5000"));
  if (!version) throw new Error("--version 不能为空");
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("--attempts 必须为正整数");
  if (!Number.isInteger(intervalMs) || intervalMs < 0) throw new Error("--interval-ms 必须为非负整数");
  await verifyRelease({ version, attempts, intervalMs });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await run();
}
