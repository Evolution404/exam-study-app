import {
  SYNC_V7_ASSET_PREFIX,
  SYNC_V7_CHECKPOINT_PREFIX,
  SYNC_V7_MAX_DESCRIPTOR_BYTES,
  SYNC_V7_MAX_SEGMENT_BYTES,
  SYNC_V7_OBJECT_PREFIX,
  SYNC_V7_SEGMENT_PREFIX,
  SYNC_V8_HISTORY_PREFIX,
  SYNC_V7_HEAD_PATH,
  assertSyncV7Path,
  validateSyncHeadV7,
} from "./sync-v7-head";
import type {
  SyncHeadV7,
  SyncV7Bytes,
  SyncV7Descriptor,
  SyncV7DescriptorKind,
  SyncV7PublicationFile,
  SyncV7PublicationPlan,
} from "./sync-v7-head";
import { decodeSyncV7JsonBytes, encodeSyncV7JsonBytes } from "./sync-v7-codec";

// Keep these names stable for callers which switch transports at runtime.
export const GITHUB_V7_API = "https://api.github.com";
export const GITHUB_V7_JSON_MEDIA_TYPE = "application/vnd.github+json";
export const GITHUB_V7_RAW_MEDIA_TYPE = "application/vnd.github.raw+json";
export const GITHUB_V7_API_VERSION = "2022-11-28";

export interface GitHubV7RemoteOptions {
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
  retryDelayMs?: number;
}

export interface SyncV7HeadCache {
  head: SyncHeadV7;
  etag?: string;
  blobSha?: string;
}

export type SyncV7HeadReadResult =
  | { status: "ok"; kind: "found"; initialized: true; fromCache: false; head: SyncHeadV7; etag?: string; blobSha?: string; cache: SyncV7HeadCache }
  | { status: "not-modified"; kind: "cached"; initialized: true; fromCache: true; head: SyncHeadV7; etag?: string; blobSha?: string; cache: SyncV7HeadCache }
  | { status: "missing"; kind: "not-initialized"; initialized: false; fromCache: false; head: null; cache: null };

export interface PutSyncV7HeadOptions {
  expectedSha?: string;
  sha?: string;
  message?: string;
}

export interface SyncV7HeadPutSuccess {
  ok: true;
  status: number;
  head: SyncHeadV7;
  blobSha: string;
  etag?: string;
  cache: SyncV7HeadCache;
}

export interface SyncV7HeadPutConflict {
  ok: false;
  reason: "cas-conflict";
  status: 409 | 422;
  classification: "head-advanced" | "head-already-exists";
  conflict: "changed" | "already-exists";
  expectedSha?: string;
}

export type SyncV7HeadPutResult = SyncV7HeadPutSuccess | SyncV7HeadPutConflict;

export interface SyncV7ImmutableFileInput {
  path: string;
  bytes: SyncV7Bytes;
  kind?: SyncV7DescriptorKind;
  sha256?: string;
  size?: number;
  message?: string;
}

export interface SyncV7ImmutablePutResult {
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

export interface SyncV7RemoteEntry {
  path: string;
  blobSha: string;
}

export interface SyncV7BlobExpectation {
  size: number;
  sha256: string;
  /** Path of the object, when known: JSON-kind objects travel through the
   *  DEFLATE envelope and are inflated before the integrity check; assets and
   *  unknown paths are verified as raw bytes. */
  path?: string;
}

export class GitHubV7RemoteError extends Error {
  readonly status: number;
  readonly operation: string;

  constructor(operation: string, status: number, message?: string) {
    super(message ?? `GitHub ${operation} failed (${status})`);
    this.name = "GitHubV7RemoteError";
    this.status = status;
    this.operation = operation;
  }
}

export class SyncV7ImmutableConflictError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`immutable v8 file content differs at ${path}`);
    this.name = "SyncV7ImmutableConflictError";
    this.path = path;
  }
}

export class SyncV7BlobIntegrityError extends Error {
  readonly reason: "size" | "sha256";
  readonly expected: number | string;
  readonly actual: number | string;

  constructor(reason: "size" | "sha256", expected: number | string, actual: number | string) {
    super(reason === "size" ? `v8 blob size mismatch: expected ${expected}, received ${actual}` : `v8 blob sha256 mismatch: expected ${expected}, received ${actual}`);
    this.name = "SyncV7BlobIntegrityError";
    this.reason = reason;
    this.expected = expected;
    this.actual = actual;
  }
}

interface GitHubContentsPayload { content?: unknown; encoding?: unknown; sha?: unknown; path?: unknown; }

function asBytes(value: SyncV7Bytes): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new TypeError("immutable v8 file bytes must be text, Uint8Array, or ArrayBuffer");
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function digestHex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", bytes as BufferSource).then((digest) => Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(""));
}

function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
}

function assertSha1(value: string, field: string): void {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new TypeError(`${field} must be a lowercase Git SHA-1 blob id`);
}

function assertSize(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractBlobSha(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as { content?: unknown; sha?: unknown; existingSha?: unknown };
  if (typeof object.existingSha === "string") return object.existingSha;
  if (object.content && typeof object.content === "object" && !Array.isArray(object.content)) return getString((object.content as { sha?: unknown }).sha);
  return getString(object.sha);
}

function parseJson(text: string, operation: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { throw new GitHubV7RemoteError(operation, 200, `GitHub ${operation} returned invalid JSON`); }
}

function parseContentsPayload(value: unknown, operation: string): { bytes: Uint8Array; blobSha?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GitHubV7RemoteError(operation, 200, "GitHub returned an invalid file envelope");
  const payload = value as GitHubContentsPayload;
  if (typeof payload.content !== "string") throw new GitHubV7RemoteError(operation, 200, "GitHub returned no base64 content");
  let bytes: Uint8Array;
  try { bytes = decodeBase64(payload.content); } catch { throw new GitHubV7RemoteError(operation, 200, "GitHub returned invalid base64 content"); }
  return { bytes, blobSha: getString(payload.sha) };
}

function contentPath(owner: string, repo: string, path: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function blobPath(owner: string, repo: string, blobSha: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(blobSha)}`;
}

function withRef(path: string, branch: string): string { return `${path}?ref=${encodeURIComponent(branch)}`; }

function cacheFrom(head: SyncHeadV7, etag?: string, blobSha?: string): SyncV7HeadCache {
  validateSyncHeadV7(head);
  if (blobSha !== undefined) assertSha1(blobSha, "head blobSha");
  return { head, ...(etag ? { etag } : {}), ...(blobSha ? { blobSha } : {}) };
}

function normalizeCache(cache: SyncV7HeadCache | SyncHeadV7 | undefined): SyncV7HeadCache | undefined {
  if (!cache) return undefined;
  if ("formatVersion" in cache) return cacheFrom(cache);
  return cacheFrom(cache.head, cache.etag, cache.blobSha);
}

function canonicalGitHubVaultIdentity(value: string): string {
  const separator = value.lastIndexOf("@");
  if (separator <= 0) return value;
  const repository = value.slice(0, separator);
  const slash = repository.indexOf("/");
  if (slash <= 0 || slash === repository.length - 1) return value;
  const owner = repository.slice(0, slash).toLocaleLowerCase("en-US");
  const repo = repository.slice(slash + 1).toLocaleLowerCase("en-US");
  return `${owner}/${repo}@${value.slice(separator + 1)}`;
}

/** GitHub owner/repository names are case-insensitive; Git ref names are not. */
export function githubVaultIdentitiesEqual(left: string, right: string): boolean {
  return canonicalGitHubVaultIdentity(left) === canonicalGitHubVaultIdentity(right);
}

export class GitHubV7Remote {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly apiBaseUrl: string;
  readonly vaultId?: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(options: GitHubV7RemoteOptions) {
    if (!options || typeof options.owner !== "string" || options.owner.length === 0) throw new TypeError("GitHub owner is required");
    if (typeof options.repo !== "string" || options.repo.length === 0) throw new TypeError("GitHub repo is required");
    if (typeof options.token !== "string") throw new TypeError("GitHub token is required");
    if (options.vaultId !== undefined && (typeof options.vaultId !== "string" || options.vaultId.length === 0)) throw new TypeError("v8 vaultId must be explicit when supplied");
    this.owner = options.owner;
    this.repo = options.repo;
    this.branch = options.branch || "main";
    this.vaultId = options.vaultId;
    this.apiBaseUrl = (options.apiBaseUrl ?? options.baseUrl ?? GITHUB_V7_API).replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.retryDelayMs = options.retryDelayMs ?? 100;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new TypeError("GitHub request timeout must be positive");
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) throw new TypeError("GitHub retry delay must be non-negative");
  }

  private assertVault(head: SyncHeadV7): void {
    if (this.vaultId !== undefined && !githubVaultIdentitiesEqual(head.vaultId, this.vaultId)) throw new GitHubV7RemoteError("vault identity", 409, "v8 head vault identity does not match this remote");
  }

  private async request(path: string, init: RequestInit = {}, accept = GITHUB_V7_JSON_MEDIA_TYPE): Promise<Response> {
    const method = (init.method ?? "GET").toString().toUpperCase();
    const canRetry = method === "GET";
    for (let attempt = 0; attempt < (canRetry ? 2 : 1); attempt += 1) {
      const headers = new Headers(init.headers);
      headers.set("Accept", accept);
      headers.set("Authorization", `Bearer ${this.token}`);
      headers.set("X-GitHub-Api-Version", GITHUB_V7_API_VERSION);
      const controller = new AbortController();
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let response: Response;
      try {
        response = await Promise.race([
          this.fetchImpl(`${this.apiBaseUrl}${path}`, { ...init, headers, signal: controller.signal }),
          new Promise<Response>((_, reject) => {
            timeoutTimer = setTimeout(() => { controller.abort(); reject(new GitHubV7RemoteError(`${method} ${path}`, 0, "GitHub request timed out")); }, this.timeoutMs);
          }),
        ]);
      } catch (error) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (canRetry && attempt === 0) {
          if (this.retryDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
          continue;
        }
        if (error instanceof GitHubV7RemoteError) throw error;
        throw new GitHubV7RemoteError(`${method} ${path}`, 0, "GitHub network request failed");
      }
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (canRetry && attempt === 0 && [502, 503, 504].includes(response.status)) {
        if (this.retryDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
        continue;
      }
      return response;
    }
    throw new GitHubV7RemoteError(`${method} ${path}`, 0, "GitHub request failed");
  }

  private requireOk(response: Response, operation: string): void {
    if (!response.ok) throw new GitHubV7RemoteError(operation, response.status);
  }

  private async readContentsMetadata(path: string): Promise<string> {
    const response = await this.request(withRef(contentPath(this.owner, this.repo, path), this.branch));
    this.requireOk(response, `read metadata ${path}`);
    const sha = extractBlobSha(parseJson(await response.text(), `read metadata ${path}`));
    if (!sha) throw new GitHubV7RemoteError(`read metadata ${path}`, 200, "GitHub did not return an existing blob SHA");
    assertSha1(sha, "existing immutable blobSha");
    return sha;
  }

  /** List immutable files in a bounded v8 maintenance namespace. */
  async listImmutableDirectory(prefix: typeof SYNC_V7_CHECKPOINT_PREFIX | typeof SYNC_V7_SEGMENT_PREFIX | typeof SYNC_V8_HISTORY_PREFIX): Promise<SyncV7RemoteEntry[]> {
    const kind: SyncV7DescriptorKind = prefix === SYNC_V7_CHECKPOINT_PREFIX ? "checkpoint" : prefix === SYNC_V7_SEGMENT_PREFIX ? "segment" : "history";
    const directory = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    const response = await this.request(withRef(contentPath(this.owner, this.repo, directory), this.branch));
    if (response.status === 404) return [];
    this.requireOk(response, `list immutable ${directory}`);
    const value = parseJson(await response.text(), `list immutable ${directory}`);
    if (!Array.isArray(value)) throw new GitHubV7RemoteError(`list immutable ${directory}`, 200, "GitHub returned an invalid directory listing");
    const entries: SyncV7RemoteEntry[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const path = getString((item as { path?: unknown }).path);
      const blobSha = getString((item as { sha?: unknown }).sha);
      const type = getString((item as { type?: unknown }).type);
      if (!path || !blobSha || (type !== undefined && type !== "file")) continue;
      assertSyncV7Path(path, kind);
      assertSha1(blobSha, "listed immutable blobSha");
      entries.push({ path, blobSha });
    }
    return entries;
  }

  /** Delete an immutable path only when its Git blob SHA still matches. */
  async deleteImmutablePath(path: string, blobSha: string): Promise<boolean> {
    const kind = inferKind(path);
    if (kind !== "checkpoint" && kind !== "segment" && kind !== "object" && kind !== "history") throw new TypeError("sync GC cannot delete assets");
    assertSyncV7Path(path, kind);
    assertSha1(blobSha, "immutable delete blobSha");
    const response = await this.request(contentPath(this.owner, this.repo, path), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `sync(v8): gc ${path}`, sha: blobSha, branch: this.branch }),
    });
    if (response.status === 404) return false;
    if (response.status === 409 || response.status === 422) return false;
    this.requireOk(response, `delete immutable ${path}`);
    return true;
  }

  async readHead(cache?: SyncV7HeadCache | SyncHeadV7): Promise<SyncV7HeadReadResult> {
    const previous = normalizeCache(cache);
    const headers = new Headers();
    if (previous?.etag) headers.set("If-None-Match", previous.etag);
    const response = await this.request(withRef(contentPath(this.owner, this.repo, SYNC_V7_HEAD_PATH), this.branch), { method: "GET", headers });
    if (response.status === 304) {
      if (!previous) throw new GitHubV7RemoteError("read v8 head (304 without cache)", 304);
      const cached = cacheFrom(previous.head, response.headers.get("etag") ?? previous.etag, previous.blobSha);
      this.assertVault(cached.head);
      return { status: "not-modified", kind: "cached", initialized: true, fromCache: true, head: cached.head, ...(cached.etag ? { etag: cached.etag } : {}), ...(cached.blobSha ? { blobSha: cached.blobSha } : {}), cache: cached };
    }
    if (response.status === 404) return { status: "missing", kind: "not-initialized", initialized: false, fromCache: false, head: null, cache: null };
    this.requireOk(response, "read v8 head");
    const payload = parseJson(await response.text(), "read v8 head");
    const file = parseContentsPayload(payload, "read v8 head");
    let head: unknown;
    try { head = parseJson(new TextDecoder().decode(file.bytes), "decode v8 head"); } catch { throw new GitHubV7RemoteError("decode v8 head", 200, "GitHub v8 head content is not valid JSON"); }
    validateSyncHeadV7(head);
    this.assertVault(head);
    const etag = response.headers.get("etag") ?? undefined;
    const blobSha = file.blobSha ?? extractBlobSha(payload);
    const resultCache = cacheFrom(head, etag, blobSha);
    return { status: "ok", kind: "found", initialized: true, fromCache: false, head, ...(etag ? { etag } : {}), ...(blobSha ? { blobSha } : {}), cache: resultCache };
  }

  async putHead(head: SyncHeadV7, expected?: string | PutSyncV7HeadOptions | SyncV7HeadCache | SyncV7HeadReadResult): Promise<SyncV7HeadPutResult> {
    validateSyncHeadV7(head);
    this.assertVault(head);
    let expectedSha: string | undefined;
    let message = "sync(v8): update head";
    if (typeof expected === "string") expectedSha = expected;
    else if (expected && "head" in expected) expectedSha = "blobSha" in expected && typeof expected.blobSha === "string" ? expected.blobSha : undefined;
    else if (expected) { expectedSha = expected.expectedSha ?? expected.sha; if (expected.message) message = expected.message; }
    if (expectedSha !== undefined) assertSha1(expectedSha, "expected head blobSha");
    const body: Record<string, unknown> = { message, content: encodeBase64(new TextEncoder().encode(JSON.stringify(head))), branch: this.branch };
    if (expectedSha) body.sha = expectedSha;
    const response = await this.request(contentPath(this.owner, this.repo, SYNC_V7_HEAD_PATH), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 409 || response.status === 422) return { ok: false, reason: "cas-conflict", status: response.status, classification: response.status === 409 ? "head-advanced" : "head-already-exists", conflict: response.status === 409 ? "changed" : "already-exists", ...(expectedSha ? { expectedSha } : {}) };
    this.requireOk(response, "put v8 head");
    const blobSha = extractBlobSha(parseJson(await response.text(), "put v8 head"));
    if (!blobSha) throw new GitHubV7RemoteError("put v8 head", response.status, "GitHub did not return the new head blob SHA");
    assertSha1(blobSha, "returned head blobSha");
    const etag = response.headers.get("etag") ?? undefined;
    return { ok: true, status: response.status, head, blobSha, ...(etag ? { etag } : {}), cache: cacheFrom(head, etag, blobSha) };
  }

  putHeadCas(head: SyncHeadV7, expected?: string | PutSyncV7HeadOptions | SyncV7HeadCache | SyncV7HeadReadResult): Promise<SyncV7HeadPutResult> { return this.putHead(head, expected); }

  private normalizeInput(inputOrPath: SyncV7ImmutableFileInput | string, bytes?: SyncV7Bytes, options?: Omit<SyncV7ImmutableFileInput, "path" | "bytes">): SyncV7ImmutableFileInput {
    if (typeof inputOrPath === "string") {
      if (bytes === undefined) throw new TypeError("immutable v8 file bytes are required");
      return { path: inputOrPath, bytes, ...options };
    }
    if (!inputOrPath || typeof inputOrPath.path !== "string") throw new TypeError("immutable v8 file path is required");
    return inputOrPath;
  }

  async putImmutable(input: SyncV7ImmutableFileInput): Promise<SyncV7ImmutablePutResult>;
  async putImmutable(path: string, bytes: SyncV7Bytes, options?: Omit<SyncV7ImmutableFileInput, "path" | "bytes">): Promise<SyncV7ImmutablePutResult>;
  async putImmutable(inputOrPath: SyncV7ImmutableFileInput | string, bytes?: SyncV7Bytes, options?: Omit<SyncV7ImmutableFileInput, "path" | "bytes">): Promise<SyncV7ImmutablePutResult> {
    const input = this.normalizeInput(inputOrPath, bytes, options);
    const kind = input.kind ?? inferKind(input.path);
    assertSyncV7Path(input.path, kind);
    const content = asBytes(input.bytes);
    const size = content.byteLength;
    assertSize(size, "immutable v8 file size");
    const maximum = kind === "segment" ? SYNC_V7_MAX_SEGMENT_BYTES : kind === "object" || kind === "checkpoint" ? SYNC_V7_MAX_DESCRIPTOR_BYTES : SYNC_V7_MAX_DESCRIPTOR_BYTES;
    if (size > maximum) throw new TypeError(`immutable v8 ${kind} exceeds its byte safety limit`);
    if (input.size !== undefined) { assertSize(input.size, "immutable v8 file size"); if (input.size !== size) throw new SyncV7BlobIntegrityError("size", input.size, size); }
    const sha256 = await digestHex(content);
    const pathHash = /\/([a-f0-9]{64})\.(?:json|webp|jpg|jpeg|png|bin)$/.exec(input.path)?.[1];
    if (pathHash && pathHash !== sha256) throw new SyncV7BlobIntegrityError("sha256", pathHash, sha256);
    if (input.sha256 !== undefined) { assertSha256(input.sha256, "immutable v8 sha256"); if (input.sha256 !== sha256) throw new SyncV7BlobIntegrityError("sha256", input.sha256, sha256); }
    // Storage envelope: JSON objects upload DEFLATE-compressed (4–5× less wire
    // traffic and remote storage); the descriptor above stays addressed to the
    // LOGICAL bytes, so identity is independent of the envelope format.
    const stored = isJsonSyncPath(input.path) ? await encodeSyncV7JsonBytes(content) : content;
    const response = await this.request(contentPath(this.owner, this.repo, input.path), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: input.message ?? `sync(v8): add ${input.path}`, content: encodeBase64(stored), branch: this.branch }) });
    if (response.status !== 422) {
      this.requireOk(response, `put immutable ${input.path}`);
      const blobSha = extractBlobSha(parseJson(await response.text(), `put immutable ${input.path}`));
      if (!blobSha) throw new GitHubV7RemoteError(`put immutable ${input.path}`, response.status, "GitHub did not return the blob SHA");
      assertSha1(blobSha, "returned immutable blobSha");
      return { path: input.path, blobSha, sha256, size, storedSize: stored.byteLength, created: response.status === 201, idempotent: false, status: response.status };
    }
    let existingSha: string | undefined;
    try { existingSha = extractBlobSha(parseJson(await response.text(), `put immutable ${input.path}`)); } catch { /* 422 body is often not JSON */ }
    if (!existingSha) existingSha = await this.readContentsMetadata(input.path);
    assertSha1(existingSha, "existing immutable blobSha");
    const existing = await this.readBlob(existingSha, { size, sha256, path: input.path });
    if (!bytesEqual(existing, content)) throw new SyncV7ImmutableConflictError(input.path);
    return { path: input.path, blobSha: existingSha, sha256, size, storedSize: stored.byteLength, created: false, idempotent: true, status: 422 };
  }

  putImmutableFile(input: SyncV7ImmutableFileInput): Promise<SyncV7ImmutablePutResult>;
  putImmutableFile(path: string, bytes: SyncV7Bytes, options?: Omit<SyncV7ImmutableFileInput, "path" | "bytes">): Promise<SyncV7ImmutablePutResult>;
  putImmutableFile(inputOrPath: SyncV7ImmutableFileInput | string, bytes?: SyncV7Bytes, options?: Omit<SyncV7ImmutableFileInput, "path" | "bytes">): Promise<SyncV7ImmutablePutResult> {
    return typeof inputOrPath === "string" ? this.putImmutable(inputOrPath, bytes as SyncV7Bytes, options) : this.putImmutable(inputOrPath);
  }

  uploadImmutable = this.putImmutable.bind(this) as GitHubV7Remote["putImmutable"];

  async readBlob(blobSha: string, expected: SyncV7BlobExpectation): Promise<Uint8Array>;
  async readBlob(descriptor: SyncV7Descriptor): Promise<Uint8Array>;
  async readBlob(blobShaOrDescriptor: string | SyncV7Descriptor, expected?: SyncV7BlobExpectation): Promise<Uint8Array> {
    const blobSha = typeof blobShaOrDescriptor === "string" ? blobShaOrDescriptor : blobShaOrDescriptor.blobSha;
    const expectation = typeof blobShaOrDescriptor === "string" ? expected : blobShaOrDescriptor;
    if (!blobSha || !expectation) throw new TypeError("blob SHA, size and sha256 are required");
    const path = typeof blobShaOrDescriptor === "string" ? expectation.path : blobShaOrDescriptor.path;
    if (typeof blobShaOrDescriptor !== "string") {
      const kind = inferKind(blobShaOrDescriptor.path);
      assertSyncV7Path(blobShaOrDescriptor.path, kind);
      if (/\/([a-f0-9]{64})\.(?:json|webp|jpg|jpeg|png|bin)$/.exec(blobShaOrDescriptor.path)?.[1] !== blobShaOrDescriptor.sha256) throw new SyncV7BlobIntegrityError("sha256", blobShaOrDescriptor.sha256, "path digest mismatch");
    }
    assertSha1(blobSha, "blobSha");
    assertSize(expectation.size, "blob size");
    assertSha256(expectation.sha256, "blob sha256");
    const response = await this.request(blobPath(this.owner, this.repo, blobSha), { method: "GET" }, GITHUB_V7_RAW_MEDIA_TYPE);
    this.requireOk(response, `read blob ${blobSha}`);
    // Inflate the DEFLATE envelope (when the object carries one) BEFORE the
    // integrity check: size and sha256 always describe the logical JSON bytes.
    const raw = new Uint8Array(await response.arrayBuffer());
    let content: Uint8Array;
    try {
      content = isJsonSyncPath(path) ? await decodeSyncV7JsonBytes(raw) : raw;
    } catch {
      // A corrupt envelope fails inflation before digests can be compared.
      throw new SyncV7BlobIntegrityError("sha256", expectation.sha256, "unreadable deflate envelope");
    }
    if (content.byteLength !== expectation.size) throw new SyncV7BlobIntegrityError("size", expectation.size, content.byteLength);
    const sha256 = await digestHex(content);
    if (sha256 !== expectation.sha256) throw new SyncV7BlobIntegrityError("sha256", expectation.sha256, sha256);
    return content;
  }

  /** Actual wire size of a stored blob (the envelope, before inflation) —
   *  one-time measurement used to backfill `storedSize` on legacy descriptors. */
  async readBlobWireSize(blobSha: string): Promise<number> {
    assertSha1(blobSha, "blobSha");
    const response = await this.request(blobPath(this.owner, this.repo, blobSha), { method: "GET" }, GITHUB_V7_RAW_MEDIA_TYPE);
    this.requireOk(response, `read blob wire size ${blobSha}`);
    return (await response.arrayBuffer()).byteLength;
  }

  readImmutableBlob(blobSha: string, expected: SyncV7BlobExpectation): Promise<Uint8Array>;
  readImmutableBlob(descriptor: SyncV7Descriptor): Promise<Uint8Array>;
  readImmutableBlob(blobShaOrDescriptor: string | SyncV7Descriptor, expected?: SyncV7BlobExpectation): Promise<Uint8Array> { return typeof blobShaOrDescriptor === "string" ? this.readBlob(blobShaOrDescriptor, expected as SyncV7BlobExpectation) : this.readBlob(blobShaOrDescriptor); }

  async readImmutableContents(path: string, expected: SyncV7BlobExpectation): Promise<Uint8Array> {
    assertSyncV7Path(path, inferKind(path));
    return this.readBlob(await this.readContentsMetadata(path), { ...expected, path });
  }

  readAsset(descriptor: SyncV7Descriptor): Promise<Uint8Array> { assertSyncV7Path(descriptor.path, "asset"); return this.readBlob(descriptor); }

  /** Publish in immutable-first order; append plans never contain checkpoints. */
  async publish(plan: SyncV7PublicationPlan): Promise<SyncV7HeadPutResult> {
    if (plan.mode === "append" && plan.checkpoint) throw new Error("ordinary v8 append cannot upload a checkpoint");
    if (plan.checkpoint && !plan.checkpoint.uploaded) await this.putPublicationFile(plan.checkpoint, "checkpoint");
    for (const object of plan.objects) if (!object.uploaded) await this.putPublicationFile(object, "object");
    for (const segment of plan.segments) if (!segment.uploaded) await this.putPublicationFile(segment, "segment");
    return this.putHead(plan.head, plan.expectedHeadSha);
  }

  private putPublicationFile(file: SyncV7PublicationFile, kind: SyncV7DescriptorKind): Promise<SyncV7ImmutablePutResult> { return this.putImmutable({ path: file.path, bytes: file.bytes, kind: file.kind ?? kind }); }
}

/** Content-hash JSON objects (checkpoints / segments / offloaded objects) use
 *  the DEFLATE envelope; assets and head.json stay raw. */
function isJsonSyncPath(path: string | undefined): boolean {
  return path !== undefined && /\/[a-f0-9]{64}\.json$/.test(path);
}

function inferKind(path: string): SyncV7DescriptorKind {
  if (path.startsWith(SYNC_V7_ASSET_PREFIX)) return "asset";
  if (path.startsWith(SYNC_V7_CHECKPOINT_PREFIX)) return "checkpoint";
  if (path.startsWith(SYNC_V7_OBJECT_PREFIX)) return "object";
  if (path.startsWith(SYNC_V8_HISTORY_PREFIX)) return "history";
  if (path.startsWith(SYNC_V7_SEGMENT_PREFIX)) return "segment";
  throw new TypeError("immutable v8 path must be in a known v8 namespace");
}

export function createGitHubV7Remote(options: GitHubV7RemoteOptions): GitHubV7Remote { return new GitHubV7Remote(options); }
export const createGithubV7Remote = createGitHubV7Remote;
export async function readSyncV7Head(options: GitHubV7RemoteOptions, cache?: SyncV7HeadCache | SyncHeadV7): Promise<SyncV7HeadReadResult> { return createGitHubV7Remote(options).readHead(cache); }
export async function putSyncV7Head(options: GitHubV7RemoteOptions, head: SyncHeadV7, expected?: string | PutSyncV7HeadOptions | SyncV7HeadCache | SyncV7HeadReadResult): Promise<SyncV7HeadPutResult> { return createGitHubV7Remote(options).putHead(head, expected); }
export async function putSyncV7ImmutableFile(options: GitHubV7RemoteOptions, input: SyncV7ImmutableFileInput): Promise<SyncV7ImmutablePutResult> { return createGitHubV7Remote(options).putImmutable(input); }
export async function readSyncV7Blob(options: GitHubV7RemoteOptions, blobSha: string, expected: SyncV7BlobExpectation): Promise<Uint8Array> { return createGitHubV7Remote(options).readBlob(blobSha, expected); }
