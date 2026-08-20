import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV7, dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import { syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

const memoryLocalStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memoryLocalStorage.get(key) ?? null,
    setItem: (key: string, value: string) => void memoryLocalStorage.set(key, value),
    removeItem: (key: string) => void memoryLocalStorage.delete(key),
  },
});

const server = await startMockGitHubServer({ cas: true });
try {
  const settings = { owner: "qa", repo: "watermark-cache-vault", branch: "main", apiBaseUrl: server.url };
  const token = "qa-token";

  await resetV7Database();
  await createBankV7("第一个题库");
  await syncWithGitHub(settings, token);

  await createBankV7("第二个题库");
  await syncWithGitHub(settings, token);

  let headGets = 0;
  let conditionalHeadGets = 0;
  const fetchWrapper = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : String((input as Request).url);
    if (url.includes("/sync/v8/head.json") && (init?.method ?? "GET").toUpperCase() === "GET") {
      headGets += 1;
      const headers = new Headers(init?.headers);
      if (headers.get("If-None-Match")) conditionalHeadGets += 1;
    }
    return fetch(input, init);
  };

  await syncWithGitHub(settings, token, undefined, { fetch: fetchWrapper as typeof fetch });
  assert.ok(headGets > 0, "第三次同步应读取 head");
  assert.ok(conditionalHeadGets > 0, "本地 head 缓存丢失 etag 后，第三次同步未发送 If-None-Match 条件请求");

  console.log("sync watermark cache tests passed");
} finally {
  await server.close();
  dbV7.close();
}
