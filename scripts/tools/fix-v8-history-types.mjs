import fs from "node:fs";

const path = "src/lib/sync/sync-v8-history.ts";
let source = fs.readFileSync(path, "utf8");
const replacements = [
  ["  } as SyncCheckpointV7;", "  } as unknown as SyncCheckpointV7;"],
  ["(value.counts as SyncCheckpointV7Counts).totalAttempts", "(value.counts as unknown as SyncCheckpointV7Counts).totalAttempts"],
  ["(value.counts as SyncCheckpointV7Counts).totalPracticeRuns", "(value.counts as unknown as SyncCheckpointV7Counts).totalPracticeRuns"],
];
for (const [from, to] of replacements) {
  if (!source.includes(from)) throw new Error(`v8 type fix target missing: ${from}`);
  source = source.replace(from, to);
}
fs.writeFileSync(path, source);
console.log("v8 history validator narrowing fixed");
