import "fake-indexeddb/auto";
import assert from "node:assert/strict";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });

const args = new Set(process.argv.slice(2));
const value = (name: string, fallback: string) => process.argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || fallback;
const apply = args.has("--apply");
const verifyExisting = args.has("--verify-existing");
const owner = value("--owner", "Evolution404");
const repo = value("--repo", "exam-study-vault");
const branch = value("--branch", "main");
const token = process.env.GITHUB_TOKEN?.trim();
if (!token) throw new Error("GITHUB_TOKEN is required (the script never prints it)");

const { resetV6Database, dbV6 } = await import("../lib/db-v6");
const { createSyncCheckpointV6 } = await import("../lib/sync-v6-checkpoint");
const { restoreFullHistoryFromGitHubV6 } = await import("../lib/github-sync-v6");
const { initializeGitHubVault, restoreFullHistoryFromGitHub, verifyGitHubVault } = await import("../lib/github-sync-v7");
const settings = { owner, repo, branch };

await resetV6Database();
const source = await restoreFullHistoryFromGitHubV6(settings, token);
const sourceCheckpoint = await createSyncCheckpointV6("2026-08-13T00:00:00.000Z");
const sourceBytes = new TextEncoder().encode(JSON.stringify(sourceCheckpoint.state));
const sourceDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(sourceBytes))), (item) => item.toString(16).padStart(2, "0")).join("");

console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceVersion: source.formatVersion, counts: sourceCheckpoint.counts, sourceDigest }, null, 2));

if (!apply) {
  await dbV6.close();
  process.exit(0);
}

const existing = await verifyGitHubVault(settings, token);
if (existing === 7 && !verifyExisting) throw new Error("sync/v7/head.json already exists; use --verify-existing to validate it without overwriting");
if (existing !== 7) await initializeGitHubVault(settings, token);

// Destructive only to this isolated fake-indexeddb process. Re-download v7
// from scratch and compare every durable projection table by canonical bytes.
await resetV6Database();
const restored = await restoreFullHistoryFromGitHub(settings, token);
const restoredCheckpoint = await createSyncCheckpointV6("2026-08-13T00:00:00.000Z");
const restoredBytes = new TextEncoder().encode(JSON.stringify(restoredCheckpoint.state));
const restoredDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(restoredBytes))), (item) => item.toString(16).padStart(2, "0")).join("");
assert.deepEqual(restoredCheckpoint.counts, sourceCheckpoint.counts, "v7 restored entity counts differ from v6 source");
assert.equal(restoredDigest, sourceDigest, "v7 restored projection digest differs from v6 source");
console.log(JSON.stringify({ migrated: true, targetVersion: restored.formatVersion, restoredDigest, counts: restoredCheckpoint.counts }, null, 2));
await dbV6.close();
