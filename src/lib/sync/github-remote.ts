import { SYNC_ASSET_PREFIX, SYNC_CHECKPOINT_PREFIX, SYNC_MAX_DESCRIPTOR_BYTES, SYNC_MAX_SEGMENT_BYTES, SYNC_OBJECT_PREFIX, SYNC_SEGMENT_PREFIX, SYNC_HISTORY_PREFIX, SYNC_HEAD_PATH } from "./sync-head-types";
import { assertSyncPath, validateSyncHead } from "./sync-head-validation";
import type { SyncHead, SyncBytes, SyncDescriptor, SyncDescriptorKind, SyncPublicationFile, SyncPublicationPlan } from "./sync-head-types";
import { decodeSyncJsonBytes, encodeSyncJsonBytes } from "./sync-codec";
import { asBytes, assertSha1, assertSha256, assertSize, bytesEqual, digestHex, extractBlobSha, getString, githubVaultIdentitiesEqual } from "./github-remote-utils";
export { githubVaultIdentitiesEqual } from "./github-remote-utils";
import {
  blobPath,
  commitGitHubTreeFastForward,
  contentPath,
  createGitHubBlob,
  decodeBase64,
  encodeBase64,
  readGitHubBranchSnapshot,
  readGitHubContentsAtRef,
  withRef,
  type GitHubBranchSnapshot,
  type GitHubTreeMutation,
} from "./github-transport";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_JSON_MEDIA_TYPE = "application/vnd.github+json";
export const GITHUB_RAW_MEDIA_TYPE = "application/vnd.github.raw+json";
export const GITHUB_API_VERSION = "2022-11-28";

export interface GitHubRemoteOptions {
  owner: string;
  repo: string;
  token: string;
  /** Explicit logical vault identity. Heads are rejected when it differs. */
  vaultId?: string;
  branch?: string;
  apiBaseUrl?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  headTimeoutMs?: number;
  retryDelayMs?: number;
}

export interface SyncHeadCache {
  head: SyncHead;
  etag?: string;
  blobSha?: string;
}

export type SyncHeadReadResult =
  | { status: "ok"; kind: "found"; initialized: true; fromCache: false; head: SyncHead; etag?: string; blobSha?: string; cache: SyncHeadCache }
  | { status: "not-modified"; kind: "cached"; initialized: true; fromCache: true; head: SyncHead; etag?: string; blobSha?: string; cache: SyncHeadCache }
  | { status: "missing"; kind: "not-initialized"; initialized: false; fromCache: false; head: null; cache: null };

export interface PutSyncHeadOptions {
  expectedSha?: string;
  sha?: string;
  message?: string;
}

export interface SyncHeadPutSuccess {
  ok: true;
  status: number;
  head: SyncHead;
  blobSha: string;
  etag?: string;
  cache: SyncHeadCache;
}

export interface SyncHeadPutConflict {
  ok: false;
  reason: "cas-conflict";
  status: 409 | 422;
  classification: "head-advanced" | "head-already-exists";
  conflict: "changed" | "already-exists";
  expectedSha?: string;
}

export type SyncHeadPutResult = SyncHeadPutSuccess | SyncHeadPutConflict;

export interface SyncImmutableFileInput {
  path: string;
  bytes: SyncBytes;
  kind?: SyncDescriptorKind;
  sha256?: string;
  size?: number;
  message?: string;
}

export interface SyncImmutablePutResult {
  path: string;
  blobSha: string;
  sha256: string;
  size: number;
  /** Actual stored/wire bytes of the uploaded object (the DEFLATE envelope). */
  storedSize: number;
  created: boolean;
  idempotent: boolean;
  status: number;
}

export interface SyncRemoteEntry {
  path: string;
  blobSha: string;
}

export interface SyncContentExpectation {
  size: number;
  sha256: string;
  /** Path of the object, when known: JSON-kind objects travel through the
   *  DEFLATE envelope and are inflated before the integrity check; assets and
   *  unknown paths are verified as raw bytes. */
  path?: string;
}

export interface SyncBlobExpectation extends SyncContentExpectation {
  /** Required actual stored/wire size for descriptor-addressed blob reads. */
  storedSize: number;
}

export interface SyncBlobReadOptions {
  /** Reports raw network bytes as the response stream is consumed. */
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
}

export class GitHubRemoteError extends Error {
  readonly status: number;
  readonly operation: string;

  constructor(operation: string, status: number, message?: string) {
    super(message ?? `GitHub ${operation} failed (${status})`);
    this.name = "GitHubRemoteError";
    this.status = status;
    this.operation = operation;
  }
}

export class SyncImmutableConflictError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`immutable v9 file content differs at ${path}`);
    this.name = "SyncImmutableConflictError";
    this.path = path;
  }
}

export class SyncBlobIntegrityError extends Error {
  readonly reason: "size" | "sha256";
  readonly expected: number | string;
  readonly actual: number | string;

  constructor(reason: "size" | "sha256", expected: number | string, actual: number | string) {
    super(reason === "size" ? `v9 blob size mismatch: expected ${expected}, received ${actual}` : `v9 blob sha256 mismatch: expected ${expected}, received ${actual}`);
    this.name = "SyncBlobIntegrityError";
    this.reason = reason;
    this.expected = expected;
    this.actual = actual;
  }
}

interface GitHubContentsPayload { content?: unknown; encoding?: unknown; sha?: unknown; path?: unknown; }

function parseJson(text: string, operation: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { throw new GitHubRemoteError(operation, 200, `GitHub ${operation} returned invalid JSON`); }
}

function parseContentsPayload(value: unknown, operation: string): { bytes: Uint8Array; blobSha?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GitHubRemoteError(operation, 200, "GitHub returned an invalid file envelope");
  const payload = value as GitHubContentsPayload;
  if (typeof payload.content !== "string") throw new GitHubRemoteError(operation, 200, "GitHub returned no base64 content");
  let bytes: Uint8Array;
  try { bytes = decodeBase64(payload.content); } catch { throw new GitHubRemoteError(operation, 200, "GitHub returned invalid base64 content"); }
  return { bytes, blobSha: getString(payload.sha) };
}

function cacheFrom(head: SyncHead, etag?: string, blobSha?: string): SyncHeadCache {
  validateSyncHead(head);
  if (blobSha !== undefined) assertSha1(blobSha, "head blobSha");
  return { head, ...(etag ? { etag } : {}), ...(blobSha ? { blobSha } : {}) };
}

function normalizeCache(cache: SyncHeadCache | SyncHead | undefined): SyncHeadCache | undefined {
  if (!cache) return undefined;
  if ("formatVersion" in cache) return cacheFrom(cache);
  return cacheFrom(cache.head, cache.etag, cache.blobSha);
}

export class GitHubRemote {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly apiBaseUrl: string;
  readonly vaultId?: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly headTimeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(options: GitHubRemoteOptions) {
    if (!options || typeof options.owner !== "string" || options.owner.length === 0) throw new TypeError("GitHub owner is required");
    if (typeof options.repo !== "string" || options.repo.length === 0) throw new TypeError("GitHub repo is required");
    if (typeof options.token !== "string") throw new TypeError("GitHub token is required");
    if (options.vaultId !== undefined && (typeof options.vaultId !== "string" || options.vaultId.length === 0)) throw new TypeError("v9 vaultId must be explicit when supplied");
    this.owner = options.owner;
    this.repo = options.repo;
    this.branch = options.branch || "main";
    this.vaultId = options.vaultId;
    this.apiBaseUrl = (options.apiBaseUrl ?? options.baseUrl ?? GITHUB_API).replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.headTimeoutMs = options.headTimeoutMs ?? Math.min(this.timeoutMs, 20_000);
    this.retryDelayMs = options.retryDelayMs ?? 100;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new TypeError("GitHub request timeout must be positive");
    if (!Number.isFinite(this.headTimeoutMs) || this.headTimeoutMs <= 0) throw new TypeError("GitHub head request timeout must be positive");
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) throw new TypeError("GitHub retry delay must be non-negative");
  }

  private assertVault(head: SyncHead): void {
    if (this.vaultId !== undefined && !githubVaultIdentitiesEqual(head.vaultId, this.vaultId)) throw new GitHubRemoteError("vault identity", 409, "v9 head vault identity does not match this remote");
  }

  async request(
    path: string,
    init: RequestInit = {},
    accept = GITHUB_JSON_MEDIA_TYPE,
    policy: { retry?: boolean; timeoutMs?: number } = {},
  ): Promise<Response> {
    const method = (init.method ?? "GET").toString().toUpperCase();
    const canRetry = method === "GET" || policy.retry === true;
    const timeoutMs = policy.timeoutMs ?? this.timeoutMs;
    for (let attempt = 0; attempt < (canRetry ? 2 : 1); attempt += 1) {
      const headers = new Headers(init.headers);
      headers.set("Accept", accept);
      headers.set("Authorization", `Bearer ${this.token}`);
      headers.set("X-GitHub-Api-Version", GITHUB_API_VERSION);
      const controller = new AbortController();
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let response: Response;
      try {
        response = await Promise.race([
          this.fetchImpl(`${this.apiBaseUrl}${path}`, { ...init, headers, signal: controller.signal }),
          new Promise<Response>((_, reject) => {
            timeoutTimer = setTimeout(() => { controller.abort(); reject(new GitHubRemoteError(`${method} ${path}`, 0, "GitHub request timed out")); }, timeoutMs);
          }),
        ]);
      } catch (error) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (canRetry && attempt === 0) {
          if (this.retryDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
          continue;
        }
        if (error instanceof GitHubRemoteError) throw error;
        throw new GitHubRemoteError(`${method} ${path}`, 0, "GitHub network request failed");
      }
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (canRetry && attempt === 0 && [502, 503, 504].includes(response.status)) {
        if (this.retryDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
        continue;
      }
      return response;
    }
    throw new GitHubRemoteError(`${method} ${path}`, 0, "GitHub request failed");
  }

  private requireOk(response: Response, operation: string): void {
    if (!response.ok) throw new GitHubRemoteError(operation, response.status);
  }

  async readContentsAtRef(path: string, ref = this.branch): Promise<Uint8Array | null> { return readGitHubContentsAtRef(this, path, ref); }
  async createGitBlob(bytes: SyncBytes): Promise<string> { return createGitHubBlob(this, asBytes(bytes)); }
  async readGitBranchSnapshot(): Promise<GitHubBranchSnapshot> { return readGitHubBranchSnapshot(this); }
  async commitGitTreeFastForward(base: GitHubBranchSnapshot, mutations: readonly GitHubTreeMutation[], message: string): Promise<boolean> { return commitGitHubTreeFastForward(this, base, mutations, message); }

  private async readContentsMetadata(path: string): Promise<string> {
    const response = await this.request(withRef(contentPath(this.owner, this.repo, path), this.branch));
    this.requireOk(response, `read metadata ${path}`);
    const sha = extractBlobSha(parseJson(await response.text(), `read metadata ${path}`));
    if (!sha) throw new GitHubRemoteError(`read metadata ${path}`, 200, "GitHub did not return an existing blob SHA");
    assertSha1(sha, "existing immutable blobSha");
    return sha;
  }

  /** List immutable files in a bounded sync maintenance namespace. */
  async listImmutableDirectory(prefix: typeof SYNC_CHECKPOINT_PREFIX | typeof SYNC_SEGMENT_PREFIX | typeof SYNC_HISTORY_PREFIX): Promise<SyncRemoteEntry[]> {
    const kind: SyncDescriptorKind = prefix === SYNC_CHECKPOINT_PREFIX ? "checkpoint" : prefix === SYNC_SEGMENT_PREFIX ? "segment" : "history";
    const directory = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    const response = await this.request(withRef(contentPath(this.owner, this.repo, directory), this.branch));
    if (response.status === 404) return [];
    this.requireOk(response, `list immutable ${directory}`);
    const value = parseJson(await response.text(), `list immutable ${directory}`);
    if (!Array.isArray(value)) throw new GitHubRemoteError(`list immutable ${directory}`, 200, "GitHub returned an invalid directory listing");
    const entries: SyncRemoteEntry[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const path = getString((item as { path?: unknown }).path);
      const blobSha = getString((item as { sha?: unknown }).sha);
      const type = getString((item as { type?: unknown }).type);
      if (!path || !blobSha || (type !== undefined && type !== "file")) continue;
      assertSyncPath(path, kind);
      assertSha1(blobSha, "listed immutable blobSha");
      entries.push({ path, blobSha });
    }
    return entries;
  }

  /** Delete an immutable path only when its Git blob SHA still matches. */
  async deleteImmutablePath(path: string, blobSha: string): Promise<boolean> {
    const kind = inferKind(path);
    if (kind !== "checkpoint" && kind !== "segment" && kind !== "object" && kind !== "history") throw new TypeError("sync GC cannot delete assets");
    assertSyncPath(path, kind);
    assertSha1(blobSha, "immutable delete blobSha");
    const response = await this.request(contentPath(this.owner, this.repo, path), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `sync(v9): gc ${path}`, sha: blobSha, branch: this.branch }),
    });
    if (response.status === 404) return false;
    if (response.status === 409 || response.status === 422) return false;
    this.requireOk(response, `delete immutable ${path}`);
    return true;
  }

  async readHead(cache?: SyncHeadCache | SyncHead): Promise<SyncHeadReadResult> {
    const previous = normalizeCache(cache);
    const headers = new Headers();
    if (previous?.etag) headers.set("If-None-Match", previous.etag);
    const response = await this.request(withRef(contentPath(this.owner, this.repo, SYNC_HEAD_PATH), this.branch), { method: "GET", headers });
    if (response.status === 304) {
      if (!previous) throw new GitHubRemoteError("read sync head (304 without cache)", 304);
      const cached = cacheFrom(previous.head, response.headers.get("etag") ?? previous.etag, previous.blobSha);
      this.assertVault(cached.head);
      return { status: "not-modified", kind: "cached", initialized: true, fromCache: true, head: cached.head, ...(cached.etag ? { etag: cached.etag } : {}), ...(cached.blobSha ? { blobSha: cached.blobSha } : {}), cache: cached };
    }
    if (response.status === 404) return { status: "missing", kind: "not-initialized", initialized: false, fromCache: false, head: null, cache: null };
    this.requireOk(response, "read sync head");
    const payload = parseJson(await response.text(), "read sync head");
    const file = parseContentsPayload(payload, "read sync head");
    let head: unknown;
    try { head = parseJson(new TextDecoder().decode(file.bytes), "decode sync head"); } catch { throw new GitHubRemoteError("decode sync head", 200, "GitHub sync head content is not valid JSON"); }
    validateSyncHead(head);
    this.assertVault(head);
    const etag = response.headers.get("etag") ?? undefined;
    const blobSha = file.blobSha ?? extractBlobSha(payload);
    const resultCache = cacheFrom(head, etag, blobSha);
    return { status: "ok", kind: "found", initialized: true, fromCache: false, head, ...(etag ? { etag } : {}), ...(blobSha ? { blobSha } : {}), cache: resultCache };
  }

  async putHead(head: SyncHead, expected?: string | PutSyncHeadOptions | SyncHeadCache | SyncHeadReadResult): Promise<SyncHeadPutResult> {
    validateSyncHead(head);
    this.assertVault(head);
    let expectedSha: string | undefined;
    let message = "sync(v9): update head";
    if (typeof expected === "string") expectedSha = expected;
    else if (expected && "head" in expected) expectedSha = "blobSha" in expected && typeof expected.blobSha === "string" ? expected.blobSha : undefined;
    else if (expected) { expectedSha = expected.expectedSha ?? expected.sha; if (expected.message) message = expected.message; }
    if (expectedSha !== undefined) assertSha1(expectedSha, "expected head blobSha");
    const body: Record<string, unknown> = { message, content: encodeBase64(new TextEncoder().encode(JSON.stringify(head))), branch: this.branch };
    if (expectedSha) body.sha = expectedSha;
    let response: Response;
    try {
      response = await this.request(
        contentPath(this.owner, this.repo, SYNC_HEAD_PATH),
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        GITHUB_JSON_MEDIA_TYPE,
        { timeoutMs: this.headTimeoutMs },
      );
    } catch (error) {
      if (!(error instanceof GitHubRemoteError) || error.status !== 0) throw error;
      // A relay/client timeout can happen after GitHub already accepted the CAS.
      // Read the tiny head back once before reporting failure; exact JSON equality
      // is valid here because this is the same object we just serialized to the
      // contents API, and it prevents a successful publish from being retried as
      // a phantom local failure.
      const recovered = await this.readHead();
      if (!recovered.initialized || JSON.stringify(recovered.head) !== JSON.stringify(head)) throw error;
      return {
        ok: true,
        status: 200,
        head,
        ...(recovered.blobSha ? { blobSha: recovered.blobSha } : { blobSha: recovered.cache.blobSha! }),
        ...(recovered.etag ? { etag: recovered.etag } : {}),
        cache: recovered.cache,
      };
    }
    if (response.status === 409 || response.status === 422) return { ok: false, reason: "cas-conflict", status: response.status, classification: response.status === 409 ? "head-advanced" : "head-already-exists", conflict: response.status === 409 ? "changed" : "already-exists", ...(expectedSha ? { expectedSha } : {}) };
    this.requireOk(response, "put sync head");
    const blobSha = extractBlobSha(parseJson(await response.text(), "put sync head"));
    if (!blobSha) throw new GitHubRemoteError("put sync head", response.status, "GitHub did not return the new head blob SHA");
    assertSha1(blobSha, "returned head blobSha");
    const etag = response.headers.get("etag") ?? undefined;
    return { ok: true, status: response.status, head, blobSha, ...(etag ? { etag } : {}), cache: cacheFrom(head, etag, blobSha) };
  }

  putHeadCas(head: SyncHead, expected?: string | PutSyncHeadOptions | SyncHeadCache | SyncHeadReadResult): Promise<SyncHeadPutResult> { return this.putHead(head, expected); }

  private normalizeInput(inputOrPath: SyncImmutableFileInput | string, bytes?: SyncBytes, options?: Omit<SyncImmutableFileInput, "path" | "bytes">): SyncImmutableFileInput {
    if (typeof inputOrPath === "string") {
      if (bytes === undefined) throw new TypeError("immutable sync file bytes are required");
      return { path: inputOrPath, bytes, ...options };
    }
    if (!inputOrPath || typeof inputOrPath.path !== "string") throw new TypeError("immutable sync file path is required");
    return inputOrPath;
  }

  async putImmutable(input: SyncImmutableFileInput): Promise<SyncImmutablePutResult>;
  async putImmutable(path: string, bytes: SyncBytes, options?: Omit<SyncImmutableFileInput, "path" | "bytes">): Promise<SyncImmutablePutResult>;
  async putImmutable(inputOrPath: SyncImmutableFileInput | string, bytes?: SyncBytes, options?: Omit<SyncImmutableFileInput, "path" | "bytes">): Promise<SyncImmutablePutResult> {
    const input = this.normalizeInput(inputOrPath, bytes, options);
    const kind = input.kind ?? inferKind(input.path);
    assertSyncPath(input.path, kind);
    const content = asBytes(input.bytes);
    const size = content.byteLength;
    assertSize(size, "immutable sync file size");
    const maximum = kind === "segment" ? SYNC_MAX_SEGMENT_BYTES : kind === "object" || kind === "checkpoint" ? SYNC_MAX_DESCRIPTOR_BYTES : SYNC_MAX_DESCRIPTOR_BYTES;
    if (size > maximum) throw new TypeError(`immutable sync ${kind} exceeds its byte safety limit`);
    if (input.size !== undefined) { assertSize(input.size, "immutable sync file size"); if (input.size !== size) throw new SyncBlobIntegrityError("size", input.size, size); }
    const sha256 = await digestHex(content);
    const pathHash = /\/([a-f0-9]{64})\.(?:json|webp|jpg|jpeg|png|bin)$/.exec(input.path)?.[1];
    if (pathHash && pathHash !== sha256) throw new SyncBlobIntegrityError("sha256", pathHash, sha256);
    if (input.sha256 !== undefined) { assertSha256(input.sha256, "immutable sync sha256"); if (input.sha256 !== sha256) throw new SyncBlobIntegrityError("sha256", input.sha256, sha256); }
    // Storage envelope: JSON objects upload DEFLATE-compressed (4–5× less wire
    // traffic and remote storage); the descriptor above stays addressed to the
    // LOGICAL bytes, so identity is independent of the envelope format.
    const stored = isJsonSyncPath(input.path) ? await encodeSyncJsonBytes(content) : content;
    const response = await this.request(
      contentPath(this.owner, this.repo, input.path),
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: input.message ?? `sync(v9): add ${input.path}`, content: encodeBase64(stored), branch: this.branch }) },
      GITHUB_JSON_MEDIA_TYPE,
      { retry: true },
    );
    if (response.status !== 422) {
      this.requireOk(response, `put immutable ${input.path}`);
      const blobSha = extractBlobSha(parseJson(await response.text(), `put immutable ${input.path}`));
      if (!blobSha) throw new GitHubRemoteError(`put immutable ${input.path}`, response.status, "GitHub did not return the blob SHA");
      assertSha1(blobSha, "returned immutable blobSha");
      return { path: input.path, blobSha, sha256, size, storedSize: stored.byteLength, created: response.status === 201, idempotent: false, status: response.status };
    }
    let existingSha: string | undefined;
    try { existingSha = extractBlobSha(parseJson(await response.text(), `put immutable ${input.path}`)); } catch { /* 422 body is often not JSON */ }
    if (!existingSha) existingSha = await this.readContentsMetadata(input.path);
    assertSha1(existingSha, "existing immutable blobSha");
    const existing = await this.readBlob(existingSha, { size, storedSize: stored.byteLength, sha256, path: input.path });
    if (!bytesEqual(existing, content)) throw new SyncImmutableConflictError(input.path);
    return { path: input.path, blobSha: existingSha, sha256, size, storedSize: stored.byteLength, created: false, idempotent: true, status: 422 };
  }

  putImmutableFile(input: SyncImmutableFileInput): Promise<SyncImmutablePutResult>;
  putImmutableFile(path: string, bytes: SyncBytes, options?: Omit<SyncImmutableFileInput, "path" | "bytes">): Promise<SyncImmutablePutResult>;
  putImmutableFile(inputOrPath: SyncImmutableFileInput | string, bytes?: SyncBytes, options?: Omit<SyncImmutableFileInput, "path" | "bytes">): Promise<SyncImmutablePutResult> {
    return typeof inputOrPath === "string" ? this.putImmutable(inputOrPath, bytes as SyncBytes, options) : this.putImmutable(inputOrPath);
  }

  uploadImmutable = this.putImmutable.bind(this);

  private async readBlobContent(blobSha: string, expectation: SyncContentExpectation, readOptions?: SyncBlobReadOptions, wireSizeHint?: number): Promise<Uint8Array> {
  assertSha1(blobSha, "blobSha");
  assertSize(expectation.size, "blob size");
  assertSha256(expectation.sha256, "blob sha256");
  const response = await this.request(blobPath(this.owner, this.repo, blobSha), { method: "GET" }, GITHUB_RAW_MEDIA_TYPE);
  this.requireOk(response, `read blob ${blobSha}`);
  const contentLength = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0
    ? contentLength
    : wireSizeHint === undefined ? expectation.size : wireSizeHint;
  let raw: Uint8Array;
  if (!response.body) {
    raw = new Uint8Array(await response.arrayBuffer());
    readOptions?.onProgress?.(raw.byteLength, totalBytes);
  } else {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loadedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      chunks.push(value);
      loadedBytes += value.byteLength;
      readOptions?.onProgress?.(loadedBytes, totalBytes);
    }
    raw = new Uint8Array(loadedBytes);
    let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    if (!loadedBytes) readOptions?.onProgress?.(0, totalBytes);
  }
  let content: Uint8Array;
  try {
    content = isJsonSyncPath(expectation.path) ? await decodeSyncJsonBytes(raw) : raw;
  } catch {
    throw new SyncBlobIntegrityError("sha256", expectation.sha256, "unreadable deflate envelope");
  }
  if (content.byteLength !== expectation.size) throw new SyncBlobIntegrityError("size", expectation.size, content.byteLength);
  const sha256 = await digestHex(content);
  if (sha256 !== expectation.sha256) throw new SyncBlobIntegrityError("sha256", expectation.sha256, sha256);
  return content;
}

async readBlob(blobSha: string, expected: SyncBlobExpectation, options?: SyncBlobReadOptions): Promise<Uint8Array>;
async readBlob(descriptor: SyncDescriptor, options?: SyncBlobReadOptions): Promise<Uint8Array>;
async readBlob(blobShaOrDescriptor: string | SyncDescriptor, expectedOrOptions?: SyncBlobExpectation | SyncBlobReadOptions, options?: SyncBlobReadOptions): Promise<Uint8Array> {
  const blobSha = typeof blobShaOrDescriptor === "string" ? blobShaOrDescriptor : blobShaOrDescriptor.blobSha;
  const expectation = typeof blobShaOrDescriptor === "string" ? expectedOrOptions as SyncBlobExpectation | undefined : blobShaOrDescriptor;
  const readOptions = typeof blobShaOrDescriptor === "string" ? options : expectedOrOptions as SyncBlobReadOptions | undefined;
  if (!blobSha || !expectation) throw new TypeError("blob SHA, size, storedSize and sha256 are required");
  const path = typeof blobShaOrDescriptor === "string" ? expectation.path : blobShaOrDescriptor.path;
  if (typeof blobShaOrDescriptor !== "string") {
    const kind = inferKind(blobShaOrDescriptor.path);
    assertSyncPath(blobShaOrDescriptor.path, kind);
    if (/\/([a-f0-9]{64})\.(?:json|webp|jpg|jpeg|png|bin)$/.exec(blobShaOrDescriptor.path)?.[1] !== blobShaOrDescriptor.sha256) throw new SyncBlobIntegrityError("sha256", blobShaOrDescriptor.sha256, "path digest mismatch");
  }
  return this.readBlobContent(blobSha, { size: expectation.size, sha256: expectation.sha256, path }, readOptions, expectation.storedSize);
}

  readImmutableBlob(blobSha: string, expected: SyncBlobExpectation): Promise<Uint8Array>;
  readImmutableBlob(descriptor: SyncDescriptor): Promise<Uint8Array>;
  readImmutableBlob(blobShaOrDescriptor: string | SyncDescriptor, expected?: SyncBlobExpectation): Promise<Uint8Array> { return typeof blobShaOrDescriptor === "string" ? this.readBlob(blobShaOrDescriptor, expected as SyncBlobExpectation) : this.readBlob(blobShaOrDescriptor); }

  async readImmutableContents(path: string, expected: SyncContentExpectation): Promise<Uint8Array> {
    assertSyncPath(path, inferKind(path));
    return this.readBlobContent(await this.readContentsMetadata(path), { ...expected, path });
  }

  readAsset(descriptor: SyncDescriptor): Promise<Uint8Array> { assertSyncPath(descriptor.path, "asset"); return this.readBlob(descriptor); }

  /** Publish in immutable-first order; append plans never contain checkpoints. */
  async publish(plan: SyncPublicationPlan): Promise<SyncHeadPutResult> {
    if (plan.mode === "append" && plan.checkpoint) throw new Error("ordinary sync append cannot upload a checkpoint");
    if (plan.checkpoint && !plan.checkpoint.uploaded) await this.putPublicationFile(plan.checkpoint, "checkpoint");
    for (const object of plan.objects) if (!object.uploaded) await this.putPublicationFile(object, "object");
    for (const segment of plan.segments) if (!segment.uploaded) await this.putPublicationFile(segment, "segment");
    return this.putHead(plan.head, plan.expectedHeadSha);
  }

  private putPublicationFile(file: SyncPublicationFile, kind: SyncDescriptorKind): Promise<SyncImmutablePutResult> { return this.putImmutable({ path: file.path, bytes: file.bytes, kind: file.kind ?? kind }); }
}

/** Content-hash JSON objects (checkpoints / segments / offloaded objects) use
 *  the DEFLATE envelope; assets and head.json stay raw. */
function isJsonSyncPath(path: string | undefined): boolean {
  return path !== undefined && /\/[a-f0-9]{64}\.json$/.test(path);
}

function inferKind(path: string): SyncDescriptorKind {
  if (path.startsWith(SYNC_ASSET_PREFIX)) return "asset";
  if (path.startsWith(SYNC_CHECKPOINT_PREFIX)) return "checkpoint";
  if (path.startsWith(SYNC_OBJECT_PREFIX)) return "object";
  if (path.startsWith(SYNC_HISTORY_PREFIX)) return "history";
  if (path.startsWith(SYNC_SEGMENT_PREFIX)) return "segment";
  throw new TypeError("immutable sync path must be in a known sync namespace");
}

export function createGitHubRemote(options: GitHubRemoteOptions): GitHubRemote { return new GitHubRemote(options); }
export const createGithubRemote = createGitHubRemote;
export async function readSyncHead(options: GitHubRemoteOptions, cache?: SyncHeadCache | SyncHead): Promise<SyncHeadReadResult> { return createGitHubRemote(options).readHead(cache); }
export async function putSyncHead(options: GitHubRemoteOptions, head: SyncHead, expected?: string | PutSyncHeadOptions | SyncHeadCache | SyncHeadReadResult): Promise<SyncHeadPutResult> { return createGitHubRemote(options).putHead(head, expected); }
export async function putSyncImmutableFile(options: GitHubRemoteOptions, input: SyncImmutableFileInput): Promise<SyncImmutablePutResult> { return createGitHubRemote(options).putImmutable(input); }
export async function readSyncBlob(options: GitHubRemoteOptions, blobSha: string, expected: SyncBlobExpectation): Promise<Uint8Array> { return createGitHubRemote(options).readBlob(blobSha, expected); }
