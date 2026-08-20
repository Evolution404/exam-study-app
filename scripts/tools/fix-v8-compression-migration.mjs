import fs from "node:fs";

const path = "src/lib/sync/sync-v7-tools.ts";
let source = fs.readFileSync(path, "utf8");
function replaceOnce(from, to, label) {
  if (!source.includes(from)) throw new Error(`v8 compression migration missing ${label}`);
  source = source.replace(from, to);
}

replaceOnce(
  `import { createSyncCheckpointV7, encodeSyncCheckpointV7, parseSyncCheckpointV7, type SyncCheckpointV7 } from "./sync-v7-checkpoint";`,
  `import { createSyncCheckpointV7, type SyncCheckpointV7 } from "./sync-v7-checkpoint";\nimport { createRemoteCheckpointV8, decodeRemoteCheckpoint, encodeSyncCheckpointV8, gcSyncV8HistoryRemote } from "./sync-v8-history";`,
  "checkpoint imports",
);

replaceOnce(
  `    const checkpoint = parseSyncCheckpointV7(await client.readBlob(head.checkpoint));`,
  `    const decodedCheckpoint = await decodeRemoteCheckpoint(client, await client.readBlob(head.checkpoint));\n    const checkpoint = decodedCheckpoint.checkpoint;`,
  "checkpoint decode",
);

replaceOnce(
  `    const newCheckpoint = await checkpointFromProjection(compacted, nextCursors);\n    const bytes = encodeSyncCheckpointV7(newCheckpoint);`,
  `    const fullCheckpoint = await checkpointFromProjection(compacted, nextCursors);\n    const newCheckpoint = await createRemoteCheckpointV8(client, fullCheckpoint);\n    const bytes = encodeSyncCheckpointV8(newCheckpoint);`,
  "checkpoint encode",
);

replaceOnce(
  `    if (verifyBytes.byteLength !== bytes.byteLength || await sha256(verifyBytes) !== digest) throw new Error("迁移后复核失败：新检查点读回不一致。");\n    return { migrated: true, verified: true, droppedTombstones, hotEvents: changes.length, bytesBefore, bytesAfter: bytes.byteLength };`,
  `    if (verifyBytes.byteLength !== bytes.byteLength || await sha256(verifyBytes) !== digest) throw new Error("迁移后复核失败：新检查点读回不一致。");\n    try { await gcSyncV8HistoryRemote(client, head, published.cache); } catch { /* best-effort */ }\n    return { migrated: true, verified: true, droppedTombstones, hotEvents: changes.length, bytesBefore, bytesAfter: bytes.byteLength };`,
  "post migration history gc",
);

fs.writeFileSync(path, source);
console.log("compression migration now supports legacy v7 and bounded v8 checkpoints");
