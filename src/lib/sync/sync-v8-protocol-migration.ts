import type { GitHubSettings } from "../../types/types";
import type { ImageAsset } from "../db/v7-types";
import { assertChangeSetProjectionV7, type ChangeSetProjectionV7 } from "./change-set-v7-projection";
import { verifyChangeSetDigestV7, type ChangeSetV7 } from "./change-set-v7";
import {
  GITHUB_V7_API,
  GITHUB_V7_API_VERSION,
  GITHUB_V7_JSON_MEDIA_TYPE,
  GITHUB_V7_RAW_MEDIA_TYPE,
  GitHubV7Remote,
  GitHubV7RemoteError,
  githubVaultIdentitiesEqual,
} from "./github-v7-remote";
import { checkpointFromProjection, projectionFromCheckpoint, replayInWireOrder } from "./sync-v7-checkpoint-bridge";
import { decodeSyncV7JsonBytes } from "./sync-v7-codec";
import { descriptorPath, sha256, vaultId } from "./sync-v7-context";
import {
  SYNC_V8_ASSET_PREFIX,
  SYNC_V8_CHECKPOINT_PREFIX,
  decodeSyncV7Segment,
  validateSyncHeadV7,
  type SyncHeadV7,
  type SyncV7Descriptor,
  type SyncV7SegmentDescriptor,
} from "./sync-v7-head";
import { hydrateSyncV7Events } from "./sync-v7-payload";
import { createRemoteCheckpointV8, decodeRemoteCheckpoint, encodeSyncCheckpointV8 } from "./sync-v8-history";
import { uploadedDescriptor } from "./sync-v7-upload";

const LEGACY_HEAD_PATH = "sync/v7/head.json";
const LEGACY_CHECKPOINT_PREFIX = "sync/v7/checkpoints/";
const LEGACY_SEGMENT_PREFIX = "sync/v7/segments/";
const LEGACY_OBJECT_PREFIX = "sync/v7/objects/";
const LEGACY_ASSET_PREFIXES = ["sync/v7/assets/", "sync/v6/assets/"] as const;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

interface LegacyHead extends Omit<SyncHeadV7, "formatVersion" | "checkpoint" | "segments"> {
  formatVersion: 7;
  checkpoint: SyncV7Descriptor | null;
  segments: SyncV7SegmentDescriptor[];
}

export interface SyncV8ProtocolMigrationResult {
  migrated: boolean;
  verified: boolean;
  reason?: string;
  legacyHeadSha?: string;
  v8HeadSha?: string;
  generation: number;
  hotEvents: number;
  copiedAssets: number;
  counts: {
    questions: number;
    banks: number;
    attempts: number;
    practiceRuns: number;
    notes: number;
    tombstones: number;
  };
}

export interface SyncV8ProtocolMigrationOptions {
  verifyOnly?: boolean;
  fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function contentPath(owner: string, repo: string, path: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function blobPath(owner: string, repo: string, blobSha: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(blobSha)}`;
}

function assertDescriptor(value: unknown, prefix: string, field: string): asserts value is SyncV7Descriptor {
  if (!isRecord(value) || typeof value.path !== "string" || !value.path.startsWith(prefix)) throw new Error(`旧 v7 ${field} 路径无效。`);
  if (typeof value.blobSha !== "string" || !SHA1.test(value.blobSha)) throw new Error(`旧 v7 ${field}.blobSha 无效。`);
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) throw new Error(`旧 v7 ${field}.sha256 无效。`);
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) throw new Error(`旧 v7 ${field}.size 无效。`);
  if (!value.path.includes(value.sha256)) throw new Error(`旧 v7 ${field} 路径摘要不匹配。`);
}

function parseLegacyHead(bytes: Uint8Array, expectedVaultId: string): LegacyHead {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("旧 v7 head 不是有效 JSON。"); }
  if (!isRecord(value) || value.formatVersion !== 7 || typeof value.vaultId !== "string") throw new Error("旧 v7 head 格式无效。");
  if (!githubVaultIdentitiesEqual(value.vaultId, expectedVaultId)) throw new Error("旧 v7 head 的 vaultId 与目标仓库不匹配。");
  if (value.checkpoint !== null) assertDescriptor(value.checkpoint, LEGACY_CHECKPOINT_PREFIX, "checkpoint");
  if (!Array.isArray(value.segments)) throw new Error("旧 v7 head.segments 必须是数组。");
  value.segments.forEach((segment, index) => assertDescriptor(segment, LEGACY_SEGMENT_PREFIX, `segments[${index}]`));

  // Reuse the strict v8 structural validator after translating only the wire
  // namespace/version. This validates cursors, metadata, ordering and limits
  // without weakening the production v8 validator.
  const translated = {
    ...value,
    formatVersion: 8,
    checkpoint: value.checkpoint === null ? null : { ...value.checkpoint, path: (value.checkpoint).path.replace(LEGACY_CHECKPOINT_PREFIX, SYNC_V8_CHECKPOINT_PREFIX) },
    segments: value.segments.map((segment) => ({ ...(segment as SyncV7SegmentDescriptor), path: (segment as SyncV7SegmentDescriptor).path.replace(LEGACY_SEGMENT_PREFIX, "sync/v8/segments/") })),
  };
  validateSyncHeadV7(translated);
  return value as unknown as LegacyHead;
}

function projectionCounts(projection: ChangeSetProjectionV7): SyncV8ProtocolMigrationResult["counts"] {
  return {
    questions: projection.questions.length,
    banks: projection.banks.length,
    attempts: projection.attempts.length,
    practiceRuns: projection.practiceRuns.length,
    notes: projection.notes.length,
    tombstones: projection.tombstones.length,
  };
}

function projectionIdentity(projection: ChangeSetProjectionV7): string {
  const sorted = <T>(items: readonly T[], key: (item: T) => string): T[] => [...items].sort((left, right) => key(left).localeCompare(key(right)));
  const canonical = {
    banks: sorted(projection.banks, (item) => item.id),
    bankFolders: sorted(projection.bankFolders, (item) => item.id),
    questions: sorted(projection.questions, (item) => item.id),
    memberships: sorted(projection.memberships, (item) => `${item.bankId}:${item.questionId}`),
    imageAssets: sorted(projection.imageAssets, (item) => item.id).map((item) => ({
      ...item,
      remote: item.remote ? { sha256: item.remote.sha256, size: item.remote.size } : undefined,
    })),
    attempts: sorted(projection.attempts, (item) => item.id),
    attemptStats: sorted(projection.attemptStats, (item) => item.questionId),
    attemptDailyStats: sorted(projection.attemptDailyStats, (item) => item.key),
    notes: sorted(projection.notes, (item) => item.questionId),
    practiceRuns: sorted(projection.practiceRuns, (item) => item.id),
    practiceRunStats: sorted(projection.practiceRunStats, (item) => item.key),
    questionGroups: sorted(projection.questionGroups, (item) => item.id),
    reviewRounds: sorted(projection.reviewRounds, (item) => item.id),
    reviewRoundProgress: sorted(projection.reviewRoundProgress, (item) => item.key),
    tombstones: sorted(projection.tombstones, (item) => item.key),
  };
  return JSON.stringify(canonical);
}

class LegacyV7Reader {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly settings: GitHubSettings,
    private readonly token: string,
    fetchImpl?: typeof fetch,
  ) {
    this.baseUrl = (settings.apiBaseUrl ?? GITHUB_V7_API).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async request(path: string, accept = GITHUB_V7_JSON_MEDIA_TYPE): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": GITHUB_V7_API_VERSION,
      },
    });
    if (!response.ok) throw new GitHubV7RemoteError(`read legacy v7 ${path}`, response.status);
    return response;
  }

  private async contents(path: string): Promise<{ bytes: Uint8Array; blobSha: string }> {
    const endpoint = `${contentPath(this.settings.owner, this.settings.repo, path)}?ref=${encodeURIComponent(this.settings.branch || "main")}`;
    const response = await this.request(endpoint);
    const value = await response.json() as unknown;
    if (!isRecord(value) || typeof value.content !== "string" || typeof value.sha !== "string" || !SHA1.test(value.sha)) {
      throw new Error(`GitHub 未返回有效的旧 v7 文件：${path}`);
    }
    return { bytes: decodeBase64(value.content), blobSha: value.sha };
  }

  async readHead(): Promise<{ head: LegacyHead; blobSha: string }> {
    const file = await this.contents(LEGACY_HEAD_PATH);
    return { head: parseLegacyHead(file.bytes, vaultId(this.settings)), blobSha: file.blobSha };
  }

  async readBlob(descriptor: SyncV7Descriptor): Promise<Uint8Array> {
    if (!SHA1.test(descriptor.blobSha) || !SHA256.test(descriptor.sha256)) throw new Error(`旧 v7 descriptor 无效：${descriptor.path}`);
    const response = await this.request(blobPath(this.settings.owner, this.settings.repo, descriptor.blobSha), GITHUB_V7_RAW_MEDIA_TYPE);
    const stored = new Uint8Array(await response.arrayBuffer());
    const logical = descriptor.path.endsWith(".json") ? await decodeSyncV7JsonBytes(stored) : stored;
    if (logical.byteLength !== descriptor.size) throw new Error(`旧 v7 对象大小不匹配：${descriptor.path}`);
    if (await sha256(logical) !== descriptor.sha256) throw new Error(`旧 v7 对象摘要不匹配：${descriptor.path}`);
    return logical;
  }

  async readImmutableContents(path: string, expected: { size: number; sha256: string }): Promise<Uint8Array> {
    if (!path.startsWith(LEGACY_OBJECT_PREFIX)) throw new Error(`旧 v7 payloadRef 路径无效：${path}`);
    const metadata = await this.contents(path);
    return this.readBlob({ path, blobSha: metadata.blobSha, size: expected.size, sha256: expected.sha256 });
  }
}

function decodeLegacySegment(bytes: Uint8Array, descriptor: SyncV7SegmentDescriptor, vault: string): ChangeSetV7[] {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error(`旧 v7 分段不是有效 JSON：${descriptor.path}`); }
  if (!isRecord(value) || value.formatVersion !== 7) throw new Error(`旧 v7 分段格式无效：${descriptor.path}`);
  const translated = { ...value, formatVersion: 8 };
  const segment = decodeSyncV7Segment<ChangeSetV7>(JSON.stringify(translated), { vaultId: vault, generation: descriptor.generation, ordinal: descriptor.ordinal });
  if (segment.events.length !== descriptor.count) throw new Error(`旧 v7 分段事件数不匹配：${descriptor.path}`);
  return segment.events;
}

async function copyAssetsToV8(
  projection: ChangeSetProjectionV7,
  legacy: LegacyV7Reader,
  target: GitHubV7Remote,
  onProgress?: (label: string) => void,
): Promise<{ projection: ChangeSetProjectionV7; copied: number }> {
  let copied = 0;
  const imageAssets: ChangeSetProjectionV7["imageAssets"] = [];
  for (const asset of projection.imageAssets) {
    if (!asset.remote || asset.remote.path.startsWith(SYNC_V8_ASSET_PREFIX)) {
      imageAssets.push(asset);
      continue;
    }
    if (!LEGACY_ASSET_PREFIXES.some((prefix) => asset.remote!.path.startsWith(prefix))) throw new Error(`图片资产不在受支持的旧命名空间：${asset.remote.path}`);
    onProgress?.(`复制图片资产 ${copied + 1}/${projection.imageAssets.length}`);
    const bytes = await legacy.readBlob(asset.remote);
    const extension = asset.remote.path.split(".").at(-1);
    if (!extension) throw new Error(`图片资产缺少扩展名：${asset.remote.path}`);
    const path = `${SYNC_V8_ASSET_PREFIX}${asset.id}.${extension}`;
    const uploaded = await target.putImmutable({ path, bytes, kind: "asset", sha256: asset.id, size: asset.size });
    imageAssets.push({
      ...(asset as Omit<ImageAsset, "blob">),
      remote: { path, blobSha: uploaded.blobSha, sha256: uploaded.sha256, size: uploaded.size },
    });
    copied += 1;
  }
  const migrated = { ...projection, imageAssets };
  assertChangeSetProjectionV7(migrated);
  return { projection: migrated, copied };
}

export async function migrateVaultToSyncV8Protocol(
  settings: GitHubSettings,
  token: string,
  onProgress?: (label: string) => void,
  options: SyncV8ProtocolMigrationOptions = {},
): Promise<SyncV8ProtocolMigrationResult> {
  const target = new GitHubV7Remote({
    owner: settings.owner,
    repo: settings.repo,
    branch: settings.branch || "main",
    token,
    apiBaseUrl: settings.apiBaseUrl,
    vaultId: vaultId(settings),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const existing = await target.readHead();
  if (existing.initialized) {
    if (!existing.head.checkpoint) throw new Error("现有 v8 head 缺少检查点。");
    const decoded = await decodeRemoteCheckpoint(target, await target.readBlob(existing.head.checkpoint));
    const projection = await projectionFromCheckpoint(decoded.checkpoint);
    assertChangeSetProjectionV7(projection);
    return {
      migrated: false,
      verified: true,
      reason: "sync/v8/head.json 已存在且检查点验证通过",
      v8HeadSha: existing.cache.blobSha,
      generation: existing.head.generation,
      hotEvents: existing.head.segments.reduce((sum, segment) => sum + segment.count, 0),
      copiedAssets: 0,
      counts: projectionCounts(projection),
    };
  }

  const legacy = new LegacyV7Reader(settings, token, options.fetch);
  onProgress?.("读取并验证旧 v7 head");
  const { head: legacyHead, blobSha: legacyHeadSha } = await legacy.readHead();
  if (!legacyHead.checkpoint) throw new Error("旧 v7 head 缺少检查点，无法迁移。");

  onProgress?.("读取并水合旧 v7 检查点");
  const decoded = await decodeRemoteCheckpoint(target, await legacy.readBlob(legacyHead.checkpoint));
  let projection = await projectionFromCheckpoint(decoded.checkpoint);
  const ordered = [...legacyHead.segments].sort((a, b) => a.generation - b.generation || a.ordinal - b.ordinal);
  const changes: ChangeSetV7[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const descriptor = ordered[index];
    onProgress?.(`验证旧 v7 热分段 ${index + 1}/${ordered.length}`);
    const events = decodeLegacySegment(await legacy.readBlob(descriptor), descriptor, legacyHead.vaultId);
    const hydrated = await hydrateSyncV7Events(events, (ref) => legacy.readImmutableContents(ref.path, { size: ref.size, sha256: ref.sha256 }));
    for (const change of hydrated) if (!await verifyChangeSetDigestV7(change)) throw new Error(`旧 v7 变更集 ${change.id} 完整性校验失败。`);
    changes.push(...hydrated);
  }
  projection = replayInWireOrder(projection, changes);
  assertChangeSetProjectionV7(projection);
  const beforeIdentity = projectionIdentity(projection);
  const counts = projectionCounts(projection);

  // Verification includes every reachable asset byte, not just descriptors.
  for (const asset of projection.imageAssets) {
    if (!asset.remote) continue;
    if (asset.remote.path.startsWith(SYNC_V8_ASSET_PREFIX)) await target.readBlob(asset.remote);
    else await legacy.readBlob(asset.remote);
  }

  if (options.verifyOnly) {
    return {
      migrated: false,
      verified: true,
      reason: "v7→v8 完整协议迁移预检通过（未写远端）",
      legacyHeadSha,
      generation: legacyHead.generation + 1,
      hotEvents: changes.length,
      copiedAssets: projection.imageAssets.filter((asset) => asset.remote && !asset.remote.path.startsWith(SYNC_V8_ASSET_PREFIX)).length,
      counts,
    };
  }

  const copied = await copyAssetsToV8(projection, legacy, target, onProgress);
  projection = copied.projection;
  const generation = legacyHead.generation + 1;
  const fullCheckpoint = await checkpointFromProjection(projection, legacyHead.cursors);
  onProgress?.("生成 v8 有界检查点与历史归档");
  const remoteCheckpoint = await createRemoteCheckpointV8(target, fullCheckpoint);
  const checkpointBytes = encodeSyncCheckpointV8(remoteCheckpoint);
  const digest = await sha256(checkpointBytes);
  const checkpointPath = descriptorPath(SYNC_V8_CHECKPOINT_PREFIX, digest);
  const descriptor: SyncV7Descriptor = { ...(await uploadedDescriptor(target, checkpointPath, checkpointBytes, "checkpoint")), generation };
  const now = new Date().toISOString();
  const head: SyncHeadV7 = {
    formatVersion: 8,
    vaultId: legacyHead.vaultId,
    generatedAt: now,
    generation,
    metadata: {
      vaultId: legacyHead.vaultId,
      producer: "exam-study-app-v8-protocol-migration",
      migratedFrom: { path: LEGACY_HEAD_PATH, blobSha: legacyHeadSha, generation: legacyHead.generation },
    },
    checkpoint: descriptor,
    segments: [],
    cursors: { ...legacyHead.cursors },
    ...(legacyHead.devices ? { devices: legacyHead.devices } : {}),
  };
  // Source pin: if any legacy device advanced v7 while immutable v8 objects
  // were uploading, do not publish a split-brain v8 head. Orphans are harmless
  // and content-addressed; a clean rerun will reuse or supersede them.
  const latestLegacy = await legacy.readHead();
  if (latestLegacy.blobSha !== legacyHeadSha) {
    throw new Error("旧 v7 head 在迁移期间发生变化，已中止 v8 head 发布；请停止旧客户端后重试。");
  }
  onProgress?.("CAS 发布 sync/v8/head.json");
  const published = await target.putHead(head);
  if (!published.ok) {
    const winner = await target.readHead();
    if (!winner.initialized) throw new Error("v8 head 发布冲突，且未找到有效胜者。");
  }

  const confirmed = await target.readHead();
  if (!confirmed.initialized || !confirmed.head.checkpoint) throw new Error("v8 head 发布后读回失败。");
  const confirmedDecoded = await decodeRemoteCheckpoint(target, await target.readBlob(confirmed.head.checkpoint));
  const confirmedProjection = await projectionFromCheckpoint(confirmedDecoded.checkpoint);
  assertChangeSetProjectionV7(confirmedProjection);
  if (projectionIdentity(confirmedProjection) !== beforeIdentity) throw new Error("v8 迁移后实体身份集合与旧 v7 数据不一致。");

  return {
    migrated: true,
    verified: true,
    legacyHeadSha,
    v8HeadSha: confirmed.cache.blobSha,
    generation: confirmed.head.generation,
    hotEvents: changes.length,
    copiedAssets: copied.copied,
    counts: projectionCounts(confirmedProjection),
  };
}
