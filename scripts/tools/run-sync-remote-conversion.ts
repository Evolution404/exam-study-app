import { createHash } from "node:crypto";
import { decodeSyncJsonBytes } from "../../src/lib/sync/sync-codec";
import { GitHubRemote, GITHUB_API_VERSION, GITHUB_RAW_MEDIA_TYPE } from "../../src/lib/sync/github-remote";
import type { SyncDescriptor, SyncDescriptorKind, SyncHead } from "../../src/lib/sync/sync-head-types";
import { validateSyncHead } from "../../src/lib/sync/sync-head-validation";
import {
  buildLegacyAssetShadowPlan,
  stageAssetShadow,
  TARGET_ASSET_INDEX_PATH,
  type AssetShadowTarget,
  type LegacyAssetSource,
} from "./sync-asset-shadow";
import {
  hydrateLegacyRemoteSnapshot,
  type LegacySyncDescriptor,
  type LegacySyncHead,
  type LegacySyncImmutableRef,
  type LegacySyncRemoteSource,
} from "./sync-remote-reader";
import {
  buildSyncShadowPlan,
  publishSyncCutover,
  stageSyncShadow,
  verifyStagedSyncShadow,
  type SyncShadowRemote,
  type StagedSyncShadow,
} from "./sync-shadow-cutover";

const SOURCE_HEAD_PATH = "sync/v9/head.json";
const API_ROOT = "https://api.github.com";
const encoder = new TextEncoder();

type Mode = "dry-run" | "cutover";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

class GitHubLegacySource implements LegacySyncRemoteSource, LegacyAssetSource {
  constructor(
    readonly owner: string,
    readonly repo: string,
    readonly branch: string,
    private readonly token: string,
  ) {}

  private headers(accept = "application/vnd.github+json"): Headers {
    const headers = new Headers({
      Accept: accept,
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "exam-study-sync-converter",
    });
    return headers;
  }

  private async request(url: string, accept?: string): Promise<Response> {
    const response = await fetch(url, { headers: this.headers(accept) });
    if (!response.ok) throw new Error(`GitHub read failed (${response.status})`);
    return response;
  }

  private async readContentsEnvelope(path: string, ref: string): Promise<{ bytes: Uint8Array; sha: string }> {
    const url = `${API_ROOT}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodedPath(path)}?ref=${encodeURIComponent(ref)}`;
    const response = await this.request(url);
    const value = await response.json() as { type?: unknown; encoding?: unknown; content?: unknown; sha?: unknown };
    if (value.type !== "file" || value.encoding !== "base64" || typeof value.content !== "string" || typeof value.sha !== "string") {
      throw new Error(`GitHub returned an invalid contents envelope for ${path}`);
    }
    return { bytes: new Uint8Array(Buffer.from(value.content.replace(/\s+/g, ""), "base64")), sha: value.sha };
  }

  private async readRawContents(path: string, ref: string): Promise<Uint8Array> {
    const url = `${API_ROOT}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodedPath(path)}?ref=${encodeURIComponent(ref)}`;
    const response = await this.request(url, GITHUB_RAW_MEDIA_TYPE);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async readRawBlob(sha: string): Promise<Uint8Array> {
    const url = `${API_ROOT}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/blobs/${encodeURIComponent(sha)}`;
    const response = await this.request(url, GITHUB_RAW_MEDIA_TYPE);
    return new Uint8Array(await response.arrayBuffer());
  }

  async readHeadAtRef(ref: string): Promise<{ head: LegacySyncHead; headSha: string }> {
    const file = await this.readContentsEnvelope(SOURCE_HEAD_PATH, ref);
    return { head: JSON.parse(new TextDecoder().decode(file.bytes)) as LegacySyncHead, headSha: file.sha };
  }

  async readHead() { return this.readHeadAtRef(this.branch); }

  async readDescriptor(descriptor: LegacySyncDescriptor): Promise<Uint8Array> {
    return decodeSyncJsonBytes(await this.readRawBlob(descriptor.blobSha));
  }

  async readImmutable(ref: LegacySyncImmutableRef): Promise<Uint8Array> {
    const stored = ref.blobSha ? await this.readRawBlob(ref.blobSha) : await this.readRawContents(ref.path, this.branch);
    return decodeSyncJsonBytes(stored);
  }

  async readAssetIndex(): Promise<Uint8Array | null> {
    try { return await this.readRawContents("sync/v9/assets/index.json", this.branch); }
    catch (error) {
      if (error instanceof Error && /\(404\)/.test(error.message)) return null;
      throw error;
    }
  }

  async readAssetBlob(descriptor: LegacySyncDescriptor): Promise<Uint8Array> {
    return this.readRawBlob(descriptor.blobSha);
  }
}

class MemoryTarget implements SyncShadowRemote, AssetShadowTarget {
  private readonly blobs = new Map<string, Uint8Array>();
  private index: Uint8Array | null = null;

  async putImmutable(input: { path: string; bytes: Uint8Array; kind: SyncDescriptorKind }): Promise<SyncDescriptor> {
    const existing = this.blobs.get(input.path);
    if (existing && !bytesEqual(existing, input.bytes)) throw new Error(`memory shadow conflict at ${input.path}`);
    if (!existing) this.blobs.set(input.path, input.bytes.slice());
    return {
      path: input.path,
      blobSha: createHash("sha1").update(input.bytes).digest("hex"),
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      size: input.bytes.byteLength,
      storedSize: input.bytes.byteLength,
    };
  }

  async readBlob(descriptor: SyncDescriptor): Promise<Uint8Array> {
    const value = this.blobs.get(descriptor.path);
    if (!value) throw new Error(`memory shadow is missing ${descriptor.path}`);
    return value.slice();
  }

  async publishAssetIndex(bytes: Uint8Array) { this.index = bytes.slice(); }
  async readAssetIndex() { return this.index?.slice() ?? null; }
}

class ProductionTarget implements SyncShadowRemote, AssetShadowTarget {
  readonly client: GitHubRemote;

  constructor(owner: string, repo: string, branch: string, token: string, vaultId: string) {
    this.client = new GitHubRemote({ owner, repo, branch, token, vaultId });
  }

  async putImmutable(input: { path: string; bytes: Uint8Array; kind: SyncDescriptorKind }): Promise<SyncDescriptor> {
    const uploaded = await this.client.putImmutable(input);
    return {
      path: uploaded.path,
      blobSha: uploaded.blobSha,
      sha256: uploaded.sha256,
      size: uploaded.size,
      storedSize: uploaded.storedSize,
    };
  }

  async readBlob(descriptor: SyncDescriptor) { return this.client.readBlob(descriptor); }

  async publishAssetIndex(bytes: Uint8Array): Promise<void> {
    const current = await this.client.readContentsAtRef(TARGET_ASSET_INDEX_PATH, this.client.branch);
    if (current && bytesEqual(current, bytes)) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await this.client.readGitBranchSnapshot();
      const blobSha = await this.client.createGitBlob(bytes);
      if (await this.client.commitGitTreeFastForward(snapshot, [{ path: TARGET_ASSET_INDEX_PATH, blobSha }], "sync: publish current asset index")) return;
    }
    throw new Error("asset index publication lost three branch CAS races");
  }

  async readAssetIndex() { return this.client.readContentsAtRef(TARGET_ASSET_INDEX_PATH, this.client.branch); }
}

async function publishHeadWithBranchCas(
  source: GitHubLegacySource,
  target: ProductionTarget,
  staged: StagedSyncShadow,
  content: string,
): Promise<void> {
  const head = JSON.parse(content) as SyncHead;
  validateSyncHead(head);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await target.client.readGitBranchSnapshot();
    const sourceAtSnapshot = await source.readHeadAtRef(snapshot.parentSha);
    if (sourceAtSnapshot.headSha !== staged.sourceHeadSha) throw new Error("source sync head changed before cutover commit");
    const blobSha = await target.client.createGitBlob(encoder.encode(content));
    if (await target.client.commitGitTreeFastForward(snapshot, [{ path: staged.cutoverHead.path, blobSha }], "sync: cut over current protocol head")) return;
  }
  throw new Error("cutover lost three branch CAS races");
}

async function main(): Promise<void> {
  const mode = (argument("mode") ?? process.env.SYNC_MODE ?? "dry-run") as Mode;
  if (mode !== "dry-run" && mode !== "cutover") throw new Error("mode must be dry-run or cutover");
  const owner = required(process.env.SYNC_VAULT_OWNER ?? "Evolution404", "SYNC_VAULT_OWNER");
  const repo = required(process.env.SYNC_VAULT_REPO ?? "exam-study-vault", "SYNC_VAULT_REPO");
  const branch = required(process.env.SYNC_VAULT_BRANCH ?? "main", "SYNC_VAULT_BRANCH");
  const token = required(process.env.SYNC_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN, "SYNC_GITHUB_TOKEN");
  const vaultId = `${owner}/${repo}@${branch}`;

  const source = new GitHubLegacySource(owner, repo, branch, token);
  const snapshot = await hydrateLegacyRemoteSnapshot(source);
  const latestSource = await source.readHead();
  if (latestSource.headSha !== snapshot.sourceHeadSha) throw new Error("source sync head changed during read-only conversion");
  const assetPlan = await buildLegacyAssetShadowPlan(source, snapshot.checkpoint.state.imageAssets);
  const syncPlan = buildSyncShadowPlan({ vaultId, sourceHeadSha: snapshot.sourceHeadSha, checkpoint: snapshot.checkpoint });

  const target: MemoryTarget | ProductionTarget = mode === "dry-run"
    ? new MemoryTarget()
    : new ProductionTarget(owner, repo, branch, token, vaultId);

  if (target instanceof ProductionTarget) {
    const existing = await target.client.readHead();
    if (existing.initialized) throw new Error("current-protocol head already exists; refusing to overwrite it");
  }

  const stagedSync = await stageSyncShadow(syncPlan, target);
  await verifyStagedSyncShadow(snapshot.checkpoint, stagedSync, target);
  const stagedAssets = await stageAssetShadow(assetPlan, target, true);

  if (mode === "cutover") {
    const production = target as ProductionTarget;
    await publishSyncCutover(stagedSync, {
      readSourceHeadSha: async () => (await source.readHead()).headSha,
      publishHead: async (_path, content) => publishHeadWithBranchCas(source, production, stagedSync, content),
    });
    const installed = await production.client.readHead();
    if (!installed.initialized || installed.head.checkpoint?.sha256 !== stagedSync.head.checkpoint?.sha256) {
      throw new Error("current-protocol head read-back verification failed");
    }
    await verifyStagedSyncShadow(snapshot.checkpoint, stagedSync, production);
  }

  console.log(JSON.stringify({
    mode,
    sourceHeadSha: snapshot.sourceHeadSha,
    hotChangeSets: snapshot.hotChangeSets,
    archivedAttempts: snapshot.archivedAttempts,
    archivedPracticeRuns: snapshot.archivedPracticeRuns,
    facts: Object.fromEntries(Object.entries(snapshot.checkpoint.state).map(([key, rows]) => [key, rows.length])),
    assetPacks: stagedAssets.packCount,
    assetShards: stagedAssets.shardCount,
    indexedAssets: stagedAssets.indexedAssetCount,
    targetCheckpoint: stagedSync.checkpointDescriptor.path,
    cutoverPublished: mode === "cutover",
  }, null, 2));
}

await main();
