import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const localStorageValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
    removeItem: (key: string) => localStorageValues.delete(key),
  },
});

const {
  db,
  resetLocalDatabase,
} = await import("../lib/db");
const { addAttemptToDailyStats, buildAttemptStats, attemptDailyKey } = await import("../lib/practice-metrics");
const {
  getLastRemoteCache,
  loadAttemptHistory,
  restoreFromGitHub,
  restoreFullHistoryFromGitHub,
  restoreLastRemoteCache,
  syncWithGitHub,
} = await import("../lib/github-sync");
type Attempt = import("../lib/types").Attempt;
type Bank = import("../lib/types").Bank;
type Question = import("../lib/types").Question;
type PracticeRun = import("../lib/types").PracticeRun;
type SyncCheckpointV3 = import("../lib/types").SyncCheckpointV3;

const settings = { owner: "restore-test", repo: "vault", branch: "main" };
const bank: Bank = {
  id: "bank-restore",
  name: "送电线路工-初级工",
  questionCount: 2,
  importedAt: "2024-01-01T00:00:00.000Z",
};
const questions: Question[] = [
  { id: "question-restore-1", bankId: bank.id, bankName: bank.name, stem: "恢复测试一", normalizedStem: "恢复测试一", answer: "A", options: ["甲", "乙"], type: "单选", tags: [] },
  { id: "question-restore-2", bankId: bank.id, bankName: bank.name, stem: "恢复测试二", normalizedStem: "恢复测试二", answer: "A", options: ["甲", "乙"], type: "单选", tags: [] },
];

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function b64(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

function fromB64(value: string) {
  return Buffer.from(value.replace(/\n/g, ""), "base64").toString("utf8");
}

/**
 * Small GitHub Git-data API emulator. It intentionally stores real contents,
 * allowing restore tests to inspect every read, write and deletion without a
 * network or a real repository.
 */
class RemoteVault {
  files = new Map<string, { content: string; sha: string }>();
  blobs = new Map<string, string>();
  requests: Array<{ method: string; url: string }> = [];
  commits = 0;
  private shaCounter = 0;

  private newSha(prefix = "sha") {
    this.shaCounter += 1;
    return `${prefix}-${this.shaCounter}`;
  }

  put(path: string, content: string) {
    const sha = this.newSha("file");
    this.files.set(path, { content, sha });
    this.blobs.set(sha, content);
    return sha;
  }

  remove(path: string) {
    this.files.delete(path);
  }

  content(path: string) {
    const item = this.files.get(path);
    assert.ok(item, `remote file is missing: ${path}`);
    return item.content;
  }

  tree() {
    return [...this.files.entries()].map(([path, item]) => ({ path, type: "blob", sha: item.sha, size: Buffer.byteLength(item.content) }));
  }

  setFetch() {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      this.requests.push({ method, url });

      if (url.includes("/git/trees/main?recursive=1") || url.includes("/git/trees/base-tree?recursive=1")) {
        return Response.json({ tree: this.tree(), truncated: false });
      }
      if (url.includes("/git/blobs/") && method === "GET") {
        const sha = url.slice(url.lastIndexOf("/") + 1);
        const content = this.blobs.get(sha);
        if (content === undefined) return new Response("missing blob", { status: 404 });
        return Response.json({ content: b64(content), encoding: "base64" });
      }
      if (url.endsWith("/git/blobs") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { content: string; encoding?: string };
        const content = body.encoding === "base64" ? fromB64(body.content) : body.content;
        const sha = this.newSha("blob");
        this.blobs.set(sha, content);
        return Response.json({ sha });
      }
      if (url.includes("/git/ref/heads/main") && method === "GET") {
        return Response.json({ object: { sha: "head" } });
      }
      if (url.includes("/git/commits/head") && method === "GET") {
        return Response.json({ tree: { sha: "base-tree" } });
      }
      if (url.endsWith("/git/trees") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { tree: Array<{ path: string; sha: string | null }> };
        for (const entry of body.tree) {
          if (entry.sha === null) {
            this.files.delete(entry.path);
            continue;
          }
          const content = this.blobs.get(entry.sha);
          if (content === undefined) throw new Error(`tree references unknown blob: ${entry.sha}`);
          this.files.set(entry.path, { content, sha: entry.sha });
        }
        return Response.json({ sha: this.newSha("tree") });
      }
      if (url.endsWith("/git/commits") && method === "POST") {
        this.commits += 1;
        return Response.json({ sha: `commit-${this.commits}` });
      }
      if (url.includes("/git/refs/heads/main") && method === "PATCH") {
        return Response.json({ object: { sha: `commit-${this.commits}` } });
      }
      if (url.includes("/contents/") && method === "PUT") {
        const marker = "/contents/";
        const encodedPath = url.slice(url.indexOf(marker) + marker.length).split("?")[0];
        const path = encodedPath.split("/").map((part) => decodeURIComponent(part)).join("/");
        const body = JSON.parse(String(init?.body)) as { content: string };
        const sha = this.put(path, fromB64(body.content));
        return Response.json({ content: { path, sha } });
      }
      throw new Error(`Unexpected GitHub request: ${method} ${url}`);
    }) as typeof globalThis.fetch;
  }

  clearRequests() {
    this.requests = [];
  }

  readsContaining(fragment: string) {
    return this.requests.filter((request) => request.method === "GET" && request.url.includes(fragment));
  }
}

function attempt(id: string, createdAt: string, questionId: string, correct: boolean): Attempt {
  return {
    id,
    runId: `run-${id}`,
    questionId,
    bankId: bank.id,
    selected: correct ? "A" : "B",
    correct,
    elapsedMs: 1_000,
    createdAt,
    deviceId: "restore-device",
  };
}

function run(id: string, updatedAt: string): PracticeRun {
  return {
    id,
    bankId: bank.id,
    bankIds: [bank.id],
    bankName: bank.name,
    mode: "random30",
    modeLabel: "随机练习",
    questionIds: [questions[0].id],
    questionTypes: { [questions[0].id]: "单选" },
    answers: { [questions[0].id]: { selected: ["A"], submitted: true, correct: true } },
    shuffleOptions: false,
    optionOrders: {},
    startedAt: updatedAt,
    updatedAt,
    completedAt: updatedAt,
    status: "completed",
    revision: 1,
  };
}

async function seedHistory() {
  await resetLocalDatabase();
  await db.banks.put(bank);
  await db.questions.bulkPut(questions);

  // 700 + 405 old rows create a 500-row segment plus smaller segments in two
  // months; the 2,000 newest rows must remain in the checkpoint.
  const attempts: Attempt[] = [];
  for (let index = 0; index < 700; index += 1) {
    const createdAt = new Date(Date.UTC(2024, 0, 1, 0, index)).toISOString();
    attempts.push(attempt(`old-jan-${index}`, createdAt, questions[index % 2].id, index % 3 !== 0));
  }
  for (let index = 0; index < 405; index += 1) {
    const createdAt = new Date(Date.UTC(2024, 1, 1, 0, index)).toISOString();
    attempts.push(attempt(`old-feb-${index}`, createdAt, questions[index % 2].id, index % 3 !== 0));
  }
  for (let index = 0; index < 2_000; index += 1) {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    attempts.push(attempt(`recent-${index}`, createdAt, questions[index % 2].id, index % 3 !== 0));
  }
  const stats = new Map<string, import("../lib/types").AttemptStats>();
  const daily = new Map<string, import("../lib/types").AttemptDailyStats>();
  for (const row of attempts) {
    stats.set(row.questionId, buildAttemptStats(attempts.filter((item) => item.questionId === row.questionId))!);
    const key = attemptDailyKey(row);
    daily.set(key, addAttemptToDailyStats(daily.get(key), row));
  }
  await db.attempts.bulkPut(attempts);
  await db.attemptStats.bulkPut([...stats.values()]);
  await db.attemptDailyStats.bulkPut([...daily.values()]);

  const runs = Array.from({ length: 205 }, (_, index) => {
    const month = index < 105 ? 0 : 1;
    const offset = index < 105 ? index : index - 105;
    return run(`run-${index}`, new Date(Date.UTC(2024, month, 1, 0, offset)).toISOString());
  });
  await db.practiceRuns.bulkPut(runs);
  await db.practiceRunStats.put({ bankId: "__all__", total: runs.length, completed: runs.length, inProgress: 0, abandoned: 0, latestUpdatedAt: runs[runs.length - 1].updatedAt });
  await db.practiceRunStats.put({ bankId: bank.id, total: runs.length, completed: runs.length, inProgress: 0, abandoned: 0, latestUpdatedAt: runs[runs.length - 1].updatedAt });
  return { attempts, runs };
}

function findArchiveRows(vault: RemoteVault, kind: "attempts" | "practice-runs") {
  return [...vault.files.entries()]
    .filter(([path]) => path.startsWith(`sync/v3/archive/${kind}/`))
    .flatMap(([, item]) => (JSON.parse(item.content) as { rows: Array<{ id: string }> }).rows);
}

const failures: string[] = [];
async function check(name: string, callback: () => Promise<void> | void) {
  try {
    await callback();
    console.log(`✓ ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`✗ ${name}: ${message}`);
  }
}

const vault = new RemoteVault();
vault.setFetch();
const seeded = await seedHistory();

await check("v3 初始化保留近期作答/练习并滚动旧记录到归档", async () => {
  const result = await syncWithGitHub(settings, "token");
  assert.equal(result.formatVersion, 3);
  assert.equal(result.compacted, true);
  const checkpointPath = [...vault.files.keys()].find((path) => path.startsWith("sync/v3/checkpoints/"));
  assert.ok(checkpointPath, "v3 checkpoint file must be written");
  const checkpoint = JSON.parse(vault.content(checkpointPath)) as SyncCheckpointV3;
  assert.equal(checkpoint.state.recentAttempts.length, 2_000);
  assert.equal(checkpoint.state.recentPracticeRuns.length, 100);
  assert.equal(checkpoint.counts.totalAttempts, seeded.attempts.length);
  assert.equal(checkpoint.counts.totalPracticeRuns, seeded.runs.length);
  assert.equal(await db.attempts.count(), 2_000, "compaction may evict only raw attempts outside the hot window");
  assert.equal(await db.practiceRuns.count(), 100, "compaction may evict only runs outside the hot window");
  const attemptRows = findArchiveRows(vault, "attempts");
  const runRows = findArchiveRows(vault, "practice-runs");
  assert.equal(attemptRows.length, 1_105);
  assert.equal(runRows.length, 105);
  assert.ok([...vault.files.keys()].filter((path) => path.startsWith("sync/v3/archive/attempts/")).length >= 3);
  assert.ok([...vault.files.keys()].filter((path) => path.startsWith("sync/v3/archive/practice-runs/")).every((path) => path.endsWith(".json")));
  const segmentPayloads = [...vault.files.entries()]
    .filter(([path]) => path.startsWith("sync/v3/archive/") && path.endsWith(".json") && path !== "sync/v3/archive/catalog.json")
    .map(([, item]) => JSON.parse(item.content) as { rows: unknown[] });
  assert.ok(segmentPayloads.every((payload) => payload.rows.length <= 500), "each archive segment must contain at most 500 rows");
});

await check("重复压缩不重复归档且 archive-index 保持唯一", async () => {
  // Add ten empty remote pages to force the compaction threshold without
  // adding history. The second compaction should retain the same catalog.
  for (let index = 0; index < 10; index += 1) vault.put(`sync/v3/events/archive-test/2026-08/page-${index}.json`, "[]");
  const catalogBefore = JSON.parse(vault.content("sync/v3/archive/catalog.json")) as { attemptSegments: unknown[]; practiceRunSegments: unknown[]; counts: unknown };
  await syncWithGitHub(settings, "token");
  const catalogAfter = JSON.parse(vault.content("sync/v3/archive/catalog.json")) as { attemptSegments: unknown[]; practiceRunSegments: unknown[]; counts: unknown };
  assert.deepEqual(catalogAfter.attemptSegments, catalogBefore.attemptSegments);
  assert.deepEqual(catalogAfter.practiceRunSegments, catalogBefore.practiceRunSegments);
  assert.deepEqual(catalogAfter.counts, catalogBefore.counts);
  const attemptIds = findArchiveRows(vault, "attempts").map((row) => row.id);
  const runIds = findArchiveRows(vault, "practice-runs").map((row) => row.id);
  assert.equal(new Set(attemptIds).size, attemptIds.length);
  assert.equal(new Set(runIds).size, runIds.length);
  assert.equal(await db.attempts.count(), 2_000);
});

await check("快速恢复只下载检查点和近期记录", async () => {
  await resetLocalDatabase();
  vault.clearRequests();
  await restoreFromGitHub(settings, "token");
  assert.equal(await db.attempts.count(), 2_000);
  assert.equal(await db.practiceRuns.count(), 100);
  assert.equal(vault.readsContaining("/sync/v3/archive/").length, 0, "quick restore must not fetch archive rows");
  assert.ok(vault.readsContaining("/git/blobs/").length >= 2);
});

await check("按月/题目按需下载历史且重复下载幂等", async () => {
  const monthResult = await loadAttemptHistory(settings, "token", { month: "2024-01", questionId: questions[0].id });
  assert.ok(monthResult.loaded > 0);
  const januaryRows = await db.attempts.where("createdAt").between("2024-01-01", "2024-02-01", true, false).toArray();
  assert.ok(januaryRows.length > 0);
  assert.ok(januaryRows.every((row) => row.questionId === questions[0].id));
  const previous = await db.syncMeta.get("archive-index:attempts");
  const previousIds = previous?.value as string[];
  const repeated = await loadAttemptHistory(settings, "token", { month: "2024-01", questionId: questions[0].id });
  assert.equal(repeated.loaded, monthResult.loaded);
  const current = (await db.syncMeta.get("archive-index:attempts"))?.value as string[];
  assert.equal(new Set(current).size, current.length);
  assert.equal(current.length, previousIds.length);
});

await check("完整恢复取回全部归档记录", async () => {
  await resetLocalDatabase();
  const result = await restoreFullHistoryFromGitHub(settings, "token");
  assert.equal(result.formatVersion, 3);
  assert.equal(result.archivedAttempts, seeded.attempts.length - 2_000);
  assert.equal(result.archivedPracticeRuns, seeded.runs.length - 100);
  assert.equal(await db.attempts.count(), seeded.attempts.length);
  assert.equal(await db.practiceRuns.count(), seeded.runs.length);
});

await check("坏 SHA 在恢复前不改变本地数据", async () => {
  await resetLocalDatabase();
  await db.banks.put({ ...bank, id: "sentinel-before-bad-sha" });
  assert.equal((await db.banks.get("sentinel-before-bad-sha"))?.id, "sentinel-before-bad-sha", "sentinel write must persist");
  const manifestPath = "sync/manifest.json";
  const originalManifest = JSON.parse(vault.content(manifestPath)) as { checkpoint: { path: string; sha256: string } };
  const badManifest = { ...originalManifest, checkpoint: { ...originalManifest.checkpoint, sha256: "0".repeat(64) } };
  vault.put(manifestPath, JSON.stringify(badManifest));
  assert.equal((await db.banks.get("sentinel-before-bad-sha"))?.id, "sentinel-before-bad-sha", "sentinel must be present before restore");
  await assert.rejects(() => restoreFromGitHub(settings, "token"));
  assert.equal((await db.banks.get("sentinel-before-bad-sha"))?.id, "sentinel-before-bad-sha");
  vault.put(manifestPath, JSON.stringify(originalManifest));
});

await check("缺失归档分段时完整恢复回滚本地数据", async () => {
  await resetLocalDatabase();
  await db.banks.put({ ...bank, id: "sentinel-before-missing-archive" });
  const catalog = JSON.parse(vault.content("sync/v3/archive/catalog.json")) as { attemptSegments: Array<{ path: string }>; practiceRunSegments: Array<{ path: string }> };
  const missingPath = catalog.attemptSegments[0].path;
  const missingContent = vault.files.get(missingPath);
  assert.ok(missingContent);
  vault.remove(missingPath);
  await assert.rejects(() => restoreFullHistoryFromGitHub(settings, "token"));
  assert.equal((await db.banks.get("sentinel-before-missing-archive"))?.id, "sentinel-before-missing-archive");
  if (missingContent) vault.files.set(missingPath, missingContent);
});

await check("本地缓存恢复不联网且覆盖后续本地修改", async () => {
  await resetLocalDatabase();
  await restoreFromGitHub(settings, "token");
  assert.ok(await getLastRemoteCache(settings));
  await db.banks.put({ ...bank, id: "local-edit-after-cache" });
  globalThis.fetch = (async () => { throw new Error("network must not be used by cached restore"); }) as typeof globalThis.fetch;
  await restoreLastRemoteCache(settings);
  assert.equal(await db.banks.get("local-edit-after-cache"), undefined);
  vault.setFetch();
});

await check("v2 迁移后只保留 v3 路径", async () => {
  const migrationVault = new RemoteVault();
  migrationVault.setFetch();
  const snapshot = {
    formatVersion: 2,
    generatedAt: "2026-08-01T00:00:00.000Z",
    state: {
      banks: [bank], bankFolders: [], questions, attempts: [attempt("migration-attempt", "2026-07-01T00:00:00.000Z", questions[0].id, true)],
      notes: [], practiceRuns: [], questionGroups: [], tombstones: [],
    },
    counts: { banks: 1, bankFolders: 0, questions: 2, attempts: 1, notes: 0, practiceRuns: 0, questionGroups: 0, tombstones: 0 },
  };
  migrationVault.put("snapshots/v2/current.json", JSON.stringify(snapshot));
  migrationVault.put("events/v2/device/2026-08/event.json", JSON.stringify([]));
  migrationVault.put("sync/manifest.json", JSON.stringify({
    formatVersion: 2,
    generatedAt: snapshot.generatedAt,
    snapshot: { path: "snapshots/v2/current.json", sha256: sha256(JSON.stringify(snapshot)) },
    eventPrefix: "events/v2/",
  }));
  await resetLocalDatabase();
  await migrationVault.setFetch();
  const result = await syncWithGitHub(settings, "token");
  assert.equal(result.migrated, true);
  assert.equal(result.formatVersion, 3);
  assert.ok([...migrationVault.files.keys()].every((path) => !path.startsWith("events/v2/") && !path.startsWith("snapshots/v2/")));
  assert.equal(JSON.parse(migrationVault.content("sync/manifest.json")).formatVersion, 3);
});

await resetLocalDatabase();
await db.delete();

if (failures.length) {
  console.error(`\n同步恢复测试发现 ${failures.length} 个问题：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("\nsync restore tests passed: retention, archive rotation, quick/full restore, lazy history, rollback, cache and v2 migration");
}
