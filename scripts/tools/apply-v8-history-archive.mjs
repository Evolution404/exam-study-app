import fs from "node:fs";

function edit(path, mutate) {
  const before = fs.readFileSync(path, "utf8");
  const after = mutate(before);
  if (after === before) throw new Error(`v8 history migration made no change: ${path}`);
  fs.writeFileSync(path, after);
}

function replaceOnce(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`v8 history migration missing ${label}`);
  return source.replace(from, to);
}

edit("src/lib/sync/sync-v7-head.ts", (input) => {
  let source = input;
  source = replaceOnce(source,
`export const SYNC_V7_OBJECT_PREFIX = "sync/v7/objects/";\nexport const SYNC_V7_SEGMENT_PREFIX = "sync/v7/segments/";`,
`export const SYNC_V7_OBJECT_PREFIX = "sync/v7/objects/";\n/** v8 bounded-checkpoint history objects use a dedicated GC-safe namespace. */\nexport const SYNC_V8_HISTORY_PREFIX = "sync/v8/history/";\nexport const SYNC_V7_SEGMENT_PREFIX = "sync/v7/segments/";`,
"v8 history prefix");
  source = replaceOnce(source,
`export type SyncV7DescriptorKind = "checkpoint" | "object" | "segment" | "asset";`,
`export type SyncV7DescriptorKind = "checkpoint" | "object" | "segment" | "asset" | "history";`,
"history descriptor kind");
  source = replaceOnce(source,
`  if (kind === "object" && !hashPath(value, SYNC_V7_OBJECT_PREFIX)) fail(\`object path must be \${SYNC_V7_OBJECT_PREFIX}<sha256>.json\`);\n  if (kind === "segment"`,
`  if (kind === "object" && !hashPath(value, SYNC_V7_OBJECT_PREFIX)) fail(\`object path must be \${SYNC_V7_OBJECT_PREFIX}<sha256>.json\`);\n  if (kind === "history" && !hashPath(value, SYNC_V8_HISTORY_PREFIX)) fail(\`history path must be \${SYNC_V8_HISTORY_PREFIX}<sha256>.json\`);\n  if (kind === "segment"`,
"history path validation");
  return source;
});

edit("src/lib/sync/github-v7-remote.ts", (input) => {
  let source = input;
  source = replaceOnce(source,
`  SYNC_V7_SEGMENT_PREFIX,\n  SYNC_V7_HEAD_PATH,`,
`  SYNC_V7_SEGMENT_PREFIX,\n  SYNC_V8_HISTORY_PREFIX,\n  SYNC_V7_HEAD_PATH,`,
"remote history prefix import");
  source = replaceOnce(source,
`  async listImmutableDirectory(prefix: typeof SYNC_V7_CHECKPOINT_PREFIX | typeof SYNC_V7_SEGMENT_PREFIX): Promise<SyncV7RemoteEntry[]> {\n    const kind: SyncV7DescriptorKind = prefix === SYNC_V7_CHECKPOINT_PREFIX ? "checkpoint" : "segment";`,
`  async listImmutableDirectory(prefix: typeof SYNC_V7_CHECKPOINT_PREFIX | typeof SYNC_V7_SEGMENT_PREFIX | typeof SYNC_V8_HISTORY_PREFIX): Promise<SyncV7RemoteEntry[]> {\n    const kind: SyncV7DescriptorKind = prefix === SYNC_V7_CHECKPOINT_PREFIX ? "checkpoint" : prefix === SYNC_V7_SEGMENT_PREFIX ? "segment" : "history";`,
"remote list history");
  source = replaceOnce(source,
`    if (kind !== "checkpoint" && kind !== "segment" && kind !== "object") throw new TypeError("v7 GC cannot delete assets");`,
`    if (kind !== "checkpoint" && kind !== "segment" && kind !== "object" && kind !== "history") throw new TypeError("sync GC cannot delete assets");`,
"remote history delete");
  source = replaceOnce(source,
`  if (path.startsWith(SYNC_V7_OBJECT_PREFIX)) return "object";\n  if (path.startsWith(SYNC_V7_SEGMENT_PREFIX)) return "segment";`,
`  if (path.startsWith(SYNC_V7_OBJECT_PREFIX)) return "object";\n  if (path.startsWith(SYNC_V8_HISTORY_PREFIX)) return "history";\n  if (path.startsWith(SYNC_V7_SEGMENT_PREFIX)) return "segment";`,
"remote infer history kind");
  return source;
});

edit("src/lib/sync/sync-v7-download.ts", (input) => {
  let source = input;
  source = replaceOnce(source,
`import { parseSyncCheckpointV7, type SyncCheckpointV7 } from "./sync-v7-checkpoint";`,
`import type { SyncCheckpointV7 } from "./sync-v7-checkpoint";\nimport { decodeRemoteCheckpoint } from "./sync-v8-history";`,
"download v8 import");
  source = replaceOnce(source,
`export async function downloadRemoteV7(client: GitHubV7Remote, head: SyncHeadV7, cached?: RemoteCacheV7, onStep?: (fraction: number, label: string) => void): Promise<{ checkpoint: SyncCheckpointV7; changes: ChangeSetV7[]; reusedCache: boolean }> {`,
`export async function downloadRemoteV7(client: GitHubV7Remote, head: SyncHeadV7, cached?: RemoteCacheV7, onStep?: (fraction: number, label: string) => void): Promise<{ checkpoint: SyncCheckpointV7; changes: ChangeSetV7[]; reusedCache: boolean; archivedAttempts: number; archivedPracticeRuns: number; remoteCheckpointFormat: 7 | 8 }> {`,
"download return type");
  source = replaceOnce(source,
`  let checkpoint: SyncCheckpointV7;\n  if (canReuse) {\n    checkpoint = cached!.checkpoint;\n  } else {`,
`  let checkpoint: SyncCheckpointV7;\n  let archivedAttempts = 0;\n  let archivedPracticeRuns = 0;\n  let remoteCheckpointFormat: 7 | 8 = 7;\n  if (canReuse) {\n    checkpoint = cached!.checkpoint;\n  } else {`,
"download archive counters");
  source = replaceOnce(source,
`    checkpoint = parseSyncCheckpointV7(await client.readBlob(head.checkpoint));`,
`    const decoded = await decodeRemoteCheckpoint(client, await client.readBlob(head.checkpoint));\n    checkpoint = decoded.checkpoint;\n    archivedAttempts = decoded.archivedAttempts;\n    archivedPracticeRuns = decoded.archivedPracticeRuns;\n    remoteCheckpointFormat = decoded.remoteFormatVersion;`,
"download v8 decode");
  source = replaceOnce(source,
`  return { checkpoint, changes, reusedCache: canReuse };`,
`  return { checkpoint, changes, reusedCache: canReuse, archivedAttempts, archivedPracticeRuns, remoteCheckpointFormat };`,
"download archive return");
  return source;
});

edit("src/lib/sync/sync-v7-orchestrator.ts", (input) => {
  let source = input;
  source = replaceOnce(source,
`import { createSyncCheckpointV7, encodeSyncCheckpointV7, type SyncCheckpointV7 } from "./sync-v7-checkpoint";`,
`import { createSyncCheckpointV7, type SyncCheckpointV7 } from "./sync-v7-checkpoint";\nimport { createRemoteCheckpointV8, encodeSyncCheckpointV8, gcSyncV8HistoryRemote } from "./sync-v8-history";`,
"orchestrator v8 imports");
  source = replaceOnce(source,
`  const checkpoint = await createSyncCheckpointV7();\n  const bytes = encodeSyncCheckpointV7(checkpoint);`,
`  const localCheckpoint = await createSyncCheckpointV7();\n  const checkpoint = await createRemoteCheckpointV8(client, localCheckpoint);\n  const bytes = encodeSyncCheckpointV8(checkpoint);`,
"initialize v8 checkpoint");
  source = replaceOnce(source,
`  await saveRemoteCache(settings, checkpoint, committed.cache);\n  const covered = await listChangeSetsV7(["pending", "blocked"]);`,
`  // Local recovery cache remains a fully hydrated v7 projection; only the\n  // remote immutable checkpoint is bounded format 8.\n  await saveRemoteCache(settings, localCheckpoint, committed.cache);\n  const covered = await listChangeSetsV7(["pending", "blocked"]);`,
"initialize local full cache");
  source = replaceOnce(source,
`  await saveQueueBase(await projectionFromCheckpoint(checkpoint));`,
`  await saveQueueBase(await projectionFromCheckpoint(localCheckpoint));`,
"initialize queue base");
  source = replaceOnce(source,
`          const checkpoint = await checkpointFromProjection(compactionProjection, { ...read.head.cursors, ...aggregateCursors }, { tombstoneGc: { devices: read.head.devices ?? {}, headCursors: { ...read.head.cursors, ...aggregateCursors }, selfDeviceId: getV7DeviceId() } });\n          const bytes = encodeSyncCheckpointV7(checkpoint);`,
`          const fullCheckpoint = await checkpointFromProjection(compactionProjection, { ...read.head.cursors, ...aggregateCursors }, { tombstoneGc: { devices: read.head.devices ?? {}, headCursors: { ...read.head.cursors, ...aggregateCursors }, selfDeviceId: getV7DeviceId() } });\n          const checkpoint = await createRemoteCheckpointV8(client, fullCheckpoint);\n          const bytes = encodeSyncCheckpointV8(checkpoint);`,
"compaction v8 checkpoint");
  source = replaceOnce(source,
`      try { await gcSyncV7Remote(client, read.head, committed.cache, { checkpointChanged: compaction.required }); } catch { /* best-effort */ }\n      // The push is already durable. Coalescing`,
`      try { await gcSyncV7Remote(client, read.head, committed.cache, { checkpointChanged: compaction.required }); } catch { /* best-effort */ }\n      if (compaction.required) {\n        try { await gcSyncV8HistoryRemote(client, read.head, committed.cache); } catch { /* best-effort */ }\n      }\n      // The push is already durable. Coalescing`,
"post-CAS v8 history GC");
  source = replaceOnce(source,
`  return { pulled: downloaded.changes.length, formatVersion: 7 as const, counts: checkpoint.counts, deferred: 0, cachedAt: new Date().toISOString(), archivedAttempts: 0, archivedPracticeRuns: 0 };`,
`  return { pulled: downloaded.changes.length, formatVersion: 7 as const, counts: checkpoint.counts, deferred: 0, cachedAt: new Date().toISOString(), archivedAttempts: downloaded.archivedAttempts, archivedPracticeRuns: downloaded.archivedPracticeRuns };`,
"restore archive counts");
  return source;
});

edit("scripts/tools/check-architecture.mjs", (input) => {
  let source = input;
  source = replaceOnce(source,
`const syncV7Checkpoint = read("src/lib/sync/sync-v7-checkpoint.ts");`,
`const syncV7Checkpoint = read("src/lib/sync/sync-v7-checkpoint.ts");\nconst syncV8History = read("src/lib/sync/sync-v8-history.ts");`,
"architecture v8 source");
  source = replaceOnce(source,
`  || !/SYNC_V7_CHECKPOINT_FORMAT\\s*=\\s*7/.test(syncV7Checkpoint)\n  || !/SYNC_V7_ASSET_PREFIX/.test(syncV7Checkpoint)) {\n  fail("公开同步入口必须使用 v7 固定 head、v7 checkpoint 格式、严格热窗口和 GitHub v7 transport");`,
`  || !/SYNC_V7_CHECKPOINT_FORMAT\\s*=\\s*7/.test(syncV7Checkpoint)\n  || !/SYNC_V8_CHECKPOINT_FORMAT\\s*=\\s*8/.test(syncV8History)\n  || !/createRemoteCheckpointV8/.test(syncV8History)\n  || !/SYNC_V7_ASSET_PREFIX/.test(syncV7Checkpoint)) {\n  fail("公开同步入口必须使用 v7 固定 head/热窗口 transport，并以 format 8 bounded checkpoint + history archive 写远端");`,
"architecture v8 guard");
  return source;
});

console.log("v8 bounded checkpoint/history archive migration applied");
