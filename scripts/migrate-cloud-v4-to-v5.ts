import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import {
  applyRemoteEvents,
  applySyncCheckpoint,
  db,
  resetLocalDatabase,
  SYNC_V5_RETENTION,
} from "../lib/db";
import { GitHubV5Remote } from "../lib/github-v5-remote";
import { initializeGitHubVaultV5, syncWithGitHubV5 } from "../lib/github-sync-v5";
import type { Attempt, PracticeRun, SyncCheckpointV5, SyncEvent } from "../lib/types";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
const localValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => localValues.set(key, value),
    removeItem: (key: string) => localValues.delete(key),
  },
});

const rawArgs = process.argv.slice(2);
const apply = rawArgs.includes("--apply");
const positional = rawArgs.filter((value) => !value.startsWith("--"));
const [owner, repo, branch = "main"] = positional;
if (!owner || !repo) {
  throw new Error("Usage: npx tsx scripts/migrate-cloud-v4-to-v5.ts <owner> <repo> [branch] [--apply]");
}

const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const settings = { owner, repo, branch };
const apiRoot = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

interface LegacyDescriptor {
  path: string;
  blobSha: string;
  sha256: string;
  size: number;
}

interface LegacyEvent extends Omit<SyncEvent, "type"> {
  type: string;
}

interface LegacyHead {
  formatVersion: 4;
  checkpoint: LegacyDescriptor;
  archiveCatalog: LegacyDescriptor;
  eventPages: LegacyDescriptor[];
}

interface LegacyCatalog {
  formatVersion: 4;
  attemptSegments: LegacyDescriptor[];
  practiceRunSegments: LegacyDescriptor[];
}

function encodedPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function requireResponse(response: Response, operation: string) {
  if (response.ok) return response;
  const message = await response.text();
  throw new Error(`${operation} failed (${response.status}): ${message.slice(0, 300)}`);
}

async function readLegacyHead(): Promise<LegacyHead> {
  const response = await requireResponse(await fetch(
    `${apiRoot}/contents/${encodedPath("sync/v4/head.json")}?ref=${encodeURIComponent(branch)}`,
    { headers },
  ), "read v4 head");
  const file = await response.json() as { content?: string; encoding?: string };
  if (file.encoding !== "base64" || typeof file.content !== "string") throw new Error("Remote v4 head has no Base64 content.");
  const head = JSON.parse(Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8")) as LegacyHead;
  if (head.formatVersion !== 4 || !head.checkpoint || !head.archiveCatalog || !Array.isArray(head.eventPages)) {
    throw new Error("Remote v4 head is invalid.");
  }
  return head;
}

async function readLegacyBytes(descriptor: LegacyDescriptor) {
  if (!descriptor?.blobSha || !Number.isSafeInteger(descriptor.size) || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) {
    throw new Error(`Invalid v4 descriptor: ${descriptor?.path ?? "unknown"}`);
  }
  const response = await requireResponse(await fetch(`${apiRoot}/git/blobs/${descriptor.blobSha}`, {
    headers: { ...headers, Accept: "application/vnd.github.raw+json" },
  }), `read ${descriptor.path}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== descriptor.size || digest !== descriptor.sha256) {
    throw new Error(`Integrity check failed for ${descriptor.path}`);
  }
  return bytes;
}

async function readLegacyJson<T>(descriptor: LegacyDescriptor): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await readLegacyBytes(descriptor))) as T;
}

function migrateEvent(event: LegacyEvent): SyncEvent & { resolvedPayload?: unknown } {
  if (event.type === "practice.run.saved") {
    const run = event.payload as PracticeRun;
    return {
      ...event,
      type: "practice.run.created",
      payload: { definition: { migratedFrom: "v4" } },
      resolvedPayload: { ...run, definitionSynced: true },
    };
  }
  return event as SyncEvent;
}

async function readLegacyRows<T>(descriptors: readonly LegacyDescriptor[], expectedKind: "attempts" | "practice-runs") {
  const rows = new Map<string, T & { id: string }>();
  for (const descriptor of descriptors) {
    const payload = await readLegacyJson<{ formatVersion: 4; kind: string; rows: Array<T & { id: string }> }>(descriptor);
    if (payload.formatVersion !== 4 || payload.kind !== expectedKind || !Array.isArray(payload.rows)) {
      throw new Error(`Invalid v4 ${expectedKind} archive: ${descriptor.path}`);
    }
    for (const row of payload.rows) rows.set(row.id, row);
  }
  return [...rows.values()];
}

const v5Client = new GitHubV5Remote({ ...settings, token });
const existingV5 = await v5Client.readHead();
if (existingV5.initialized) throw new Error("Remote v5 head already exists; migration refused to overwrite it.");

const v4Head = await readLegacyHead();
const checkpointV4 = await readLegacyJson<Omit<SyncCheckpointV5, "formatVersion"> & { formatVersion: 4 }>(v4Head.checkpoint);
const catalogV4 = await readLegacyJson<LegacyCatalog>(v4Head.archiveCatalog);
if (checkpointV4.formatVersion !== 4 || catalogV4.formatVersion !== 4) throw new Error("Remote v4 checkpoint/catalog is invalid.");

const hotEvents: LegacyEvent[] = [];
for (const descriptor of v4Head.eventPages) {
  const page = await readLegacyJson<{ formatVersion: 4; events: LegacyEvent[] }>(descriptor);
  if (page.formatVersion !== 4 || !Array.isArray(page.events)) throw new Error(`Invalid v4 event page: ${descriptor.path}`);
  hotEvents.push(...page.events);
}
const [archivedAttempts, archivedRuns] = await Promise.all([
  readLegacyRows<Attempt>(catalogV4.attemptSegments, "attempts"),
  readLegacyRows<PracticeRun>(catalogV4.practiceRunSegments, "practice-runs"),
]);

await resetLocalDatabase();
await applySyncCheckpoint({ ...checkpointV4, formatVersion: 5 });
await applyRemoteEvents(hotEvents.map(migrateEvent));
if (archivedAttempts.length) await db.attempts.bulkPut(archivedAttempts);
if (archivedRuns.length) await db.practiceRuns.bulkPut(archivedRuns.map((run) => ({ ...run, definitionSynced: true })));
await db.practiceRuns.toCollection().modify({ definitionSynced: true });

const sourceCounts = {
  banks: await db.banks.count(),
  questions: await db.questions.count(),
  attempts: await db.attempts.count(),
  practiceRuns: await db.practiceRuns.count(),
  hotEvents: hotEvents.length,
  archivedAttempts: archivedAttempts.length,
  archivedPracticeRuns: archivedRuns.length,
};

if (!apply) {
  console.log(JSON.stringify({ changed: true, dryRun: true, source: "sync/v4/head.json", target: "sync/v5/head.json", counts: sourceCounts }, null, 2));
  process.exit(0);
}

const initialized = await initializeGitHubVaultV5(settings, token);
assert.equal(initialized.initialized, true, "v5 head must be created by this migration");
let compactionRounds = 0;
while ((await db.attempts.count()) > SYNC_V5_RETENTION.recentAttempts
  || (await db.practiceRuns.count()) > SYNC_V5_RETENTION.recentPracticeRuns) {
  if (compactionRounds >= 100) throw new Error("v5 archive conversion exceeded 100 compaction rounds.");
  await syncWithGitHubV5(settings, token);
  compactionRounds += 1;
}
const verified = await v5Client.readHead();
if (!verified.initialized || verified.head.formatVersion !== 5) throw new Error("Remote v5 head verification failed.");
console.log(JSON.stringify({
  changed: true,
  dryRun: false,
  source: "sync/v4/head.json",
  target: "sync/v5/head.json",
  counts: sourceCounts,
  compactionRounds,
  checkpoint: verified.head.checkpoint.path,
  archiveCatalog: verified.head.archiveCatalog.path,
}, null, 2));
