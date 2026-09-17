import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBank, studyDb, resetDatabase } from "../../src/lib/db/db";
import { restoreFullHistoryFromGitHub, syncWithGitHub } from "../../src/lib/sync/github-sync-engine";
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
const originalQuestionsToArray = studyDb.questions.toArray.bind(studyDb.questions);
const originalAttemptsToArray = studyDb.attempts.toArray.bind(studyDb.attempts);
try {
  const settings = { owner: "qa", repo: "restore-claimed-guard-vault", branch: "main", apiBaseUrl: server.url };
  await resetDatabase();
  await createBank("已同步题库");
  await syncWithGitHub(settings, "qa-token");

  await createBank("未同步题库");
  await studyDb.transaction("rw", studyDb.changeSets, async () => {
    const pending = await studyDb.changeSets.where("state").equals("pending").toArray();
    if (pending.length) await studyDb.changeSets.bulkPut(pending.map((record) => ({ ...record, state: "claimed" as const, claimId: "claim-x", claimedAt: new Date().toISOString() })));
  });

  await assert.rejects(
    restoreFullHistoryFromGitHub(settings, "qa-token"),
    /未同步/,
    "远端恢复也应守卫 claimed 状态的本地变更",
  );

  // A clean destructive restore already owns the exact final projection in
  // memory. It must not write it and then immediately toArray() the large
  // questions/attempts stores again merely to rebuild the local remote cache.
  await resetDatabase();
  let postInstallProjectionReads = 0;
  studyDb.questions.toArray = (() => {
    postInstallProjectionReads += 1;
    return originalQuestionsToArray();
  }) as typeof studyDb.questions.toArray;
  studyDb.attempts.toArray = (() => {
    postInstallProjectionReads += 1;
    return originalAttemptsToArray();
  }) as typeof studyDb.attempts.toArray;

  const restored = await restoreFullHistoryFromGitHub(settings, "qa-token");
  assert.equal(await studyDb.banks.count(), 1, "完整远端恢复后应安装已同步题库");
  assert.equal(restored.counts.banks, 1, "返回的恢复统计应直接来自已安装 projection");
  assert.equal(postInstallProjectionReads, 0, "完整恢复不得在安装后重新全量读取 questions/attempts 构建 checkpoint cache");

  console.log("sync restore full tests passed: claimed guard + no post-install projection reread");
} finally {
  studyDb.questions.toArray = originalQuestionsToArray;
  studyDb.attempts.toArray = originalAttemptsToArray;
  await server.close();
  studyDb.close();
}
