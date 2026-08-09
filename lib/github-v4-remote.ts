import {
  SYNC_V4_ARCHIVE_CATALOG_PREFIX,
  SYNC_V4_CHECKPOINT_PREFIX,
  SYNC_V4_EVENT_PREFIX,
  SYNC_V4_HEAD_PATH,
  SYNC_V4_MAX_PATH_LENGTH,
  validateSyncHeadV4,
} from "./sync-v4-head";
import type { SyncHeadV4 } from "./types";

/** GitHub's default API endpoint.  Tests can provide an isolated endpoint. */
export const GITHUB_V4_API = "https://api.github.com";
export const GITHUB_V4_JSON_MEDIA_TYPE = "application/vnd.github+json";
export const GITHUB_V4_RAW_MEDIA_TYPE = "application/vnd.github.raw+json";
export const GITHUB_V4_API_VERSION = "2022-11-28";

export interface GitHubV4RemoteOptions {
  owner: string;
  repo: string;
  token: string;
  branch?: string;
  /** Optional API root, useful for GitHub Enterprise and deterministic tests. */
  apiBaseUrl?: string;
  /** Alias accepted for callers that already use a generic `baseUrl` option. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Upper bound for each network attempt. Defaults to 12 seconds. */
  timeoutMs?: number;
  /** Delay before the single retry of a GET. Defaults to 100 ms. */
  retryDelayMs?: number;
}

export interface SyncV4HeadCache {
  head: SyncHeadV4;
  /** The ETag returned by the Contents endpoint, including quotes if present. */
  etag?: string;
  /** GitHub's blob SHA for sync/v4/head.json. */
  blobSha?: string;
}

export type SyncV4HeadReadResult =
  | {
      status: "ok";
      kind: "found";
      initialized: true;
      fromCache: false;
      head: SyncHeadV4;
      etag?: string;
      blobSha?: string;
      cache: SyncV4HeadCache;
    }
  | {
      status: "not-modified";
      kind: "cached";
      initialized: true;
      fromCache: true;
      head: SyncHeadV4;
      etag?: string;
      blobSha?: string;
      cache: SyncV4HeadCache;
    }
  | {
      status: "missing";
      kind: "not-initialized";
      initialized: false;
      fromCache: false;
      head: null;
      etag?: undefined;
      blobSha?: undefined;
      cache: null;
    };

export interface PutSyncV4HeadOptions {
  /** Blob SHA read immediately before the write. Omit to create a new head. */
  expectedSha?: string;
  /** Alias for expectedSha, matching the request field GitHub calls `sha`. */
  sha?: string;
  message?: string;
}

export interface SyncV4HeadPutSuccess {
  ok: true;
  status: number;
  head: SyncHeadV4;
  blobSha: string;
  etag?: string;
  cache: SyncV4HeadCache;
}

export interface SyncV4HeadPutConflict {
  ok: false;
  reason: "cas-conflict";
  status: number;
  expectedSha?: string;
}

export type SyncV4HeadPutResult = SyncV4HeadPutSuccess | SyncV4HeadPutConflict;

export type ImmutableBytes = Uint8Array | ArrayBuffer | string;

export interface SyncV4ImmutableFileInput {
  path: string;
  bytes: ImmutableBytes;
  /** Optional protocol kind adds prefix/path validation. */
  kind?: "checkpoint" | "archiveCatalog" | "archiveSegment" | "eventPage";
  /** Optional caller-computed digest. It is always checked against bytes. */
  sha256?: string;
  /** Optional caller-computed size. It is always checked against bytes. */
  size?: number;
  message?: string;
}

export interface SyncV4ImmutablePutResult {
  path: string;
  blobSha: string;
  sha256: string;
  size: number;
  /** True only when Contents PUT created a new file. */
  created: boolean;
  /** True when a 422 was reconciled with an identical existing file. */
  idempotent: boolean;
  status: number;
}

export interface SyncV4BlobExpectation {
  size: number;
  sha256: string;
}

/** Errors carry status and operation metadata, but never request headers/tokens. */
export class GitHubV4RemoteError extends Error {
  readonly status: number;
  readonly operation: string;

  constructor(operation: string, status: number, message?: string) {
    super(message ?? `GitHub ${operation} failed (${status})`);
    this.name = "GitHubV4RemoteError";
    this.status = status;
    this.operation = operation;
  }
}

export class SyncV4ImmutableConflictError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`immutable v4 file content differs at ${path}`);
    this.name = "SyncV4ImmutableConflictError";
    this.path = path;
  }
}

export class SyncV4BlobIntegrityError extends Error {
  readonly reason: "size" | "sha256";
  readonly expected: number | string;
  readonly actual: number | string;

  constructor(reason: "size" | "sha256", expected: number | string, actual: number | string) {
    super(reason === "size"
      ? `v4 blob size mismatch: expected ${expected}, received ${actual}`
      : `v4 blob sha256 mismatch: expected ${expected}, received ${actual}`);
    this.name = "SyncV4BlobIntegrityError";
    this.reason = reason;
    this.expected = expected;
    this.actual = actual;
  }
}

interface GitHubContentsPayload {
  content?: unknown;
  encoding?: unknown;
  sha?: unknown;
  path?: unknown;
}

interface ContentsFile {
  bytes: Uint8Array;
  blobSha?: string;
}

function asBytes(value: ImmutableBytes): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new TypeError("immutable v4 file bytes must be text, Uint8Array, or ArrayBuffer");
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function digestHex(algorithm: AlgorithmIdentifier, bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest(algorithm, bytes as BufferSource).then((digest) => (
    Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")
  ));
}

function assertDigest(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
}

function assertExpectedSize(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
}

function assertSafePath(path: string): void {
  if (typeof path !== "string" || path.length === 0 || path.length > SYNC_V4_MAX_PATH_LENGTH
    || path.startsWith("/") || path.includes("\\")
    || [...path].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
    throw new TypeError("immutable v4 path must be a safe relative path");
  }
  if (path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError("immutable v4 path must not contain dot or empty segments");
  }
  if (path === SYNC_V4_HEAD_PATH) throw new TypeError("head.json is mutable; use putHead instead");
}

function assertKindPath(path: string, kind: SyncV4ImmutableFileInput["kind"]): void {
  if (!kind) return;
  if (kind === "eventPage" && (!path.startsWith(SYNC_V4_EVENT_PREFIX) || !path.endsWith(".json"))) {
    throw new TypeError(`event page path must be under ${SYNC_V4_EVENT_PREFIX}`);
  }
  if (kind === "checkpoint" && (!path.startsWith(SYNC_V4_CHECKPOINT_PREFIX) || !path.endsWith(".json"))) {
    throw new TypeError(`checkpoint path must be under ${SYNC_V4_CHECKPOINT_PREFIX}`);
  }
  if (kind === "archiveCatalog" && !new RegExp(`^${SYNC_V4_ARCHIVE_CATALOG_PREFIX}[a-f0-9]{24,64}\\.json$`).test(path)) {
    throw new TypeError(`archive catalog path must be under ${SYNC_V4_ARCHIVE_CATALOG_PREFIX} with a hexadecimal digest filename`);
  }
  if (kind === "archiveSegment" && !/^sync\/v4\/archive\/(attempts|practice-runs)\/\d{4}-(0[1-9]|1[0-2])\/[a-f0-9]{64}\.json$/.test(path)) {
    throw new TypeError("archive segment path must be content addressed and grouped by month");
  }
}

function archivePathDigest(path: string): string | undefined {
  if (!path.startsWith("sync/v4/archive/")) return undefined;
  const match = /\/([a-f0-9]{24,64})\.json$/.exec(path);
  if (!match) throw new TypeError("v4 archive path must end with a content digest");
  return match[1];
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeCache(cache: SyncV4HeadCache | SyncHeadV4 | undefined): SyncV4HeadCache | undefined {
  if (!cache) return undefined;
  if ("formatVersion" in cache) {
    validateSyncHeadV4(cache);
    return { head: cache };
  }
  validateSyncHeadV4(cache.head);
  return { head: cache.head, etag: cache.etag, blobSha: cache.blobSha };
}

function cacheFrom(head: SyncHeadV4, etag?: string, blobSha?: string): SyncV4HeadCache {
  validateSyncHeadV4(head);
  return { head, ...(etag ? { etag } : {}), ...(blobSha ? { blobSha } : {}) };
}

function extractBlobSha(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return getString((value as { content?: unknown }).content && typeof (value as { content: unknown }).content === "object"
    ? ((value as { content: { sha?: unknown } }).content).sha
    : (value as { sha?: unknown }).sha);
}

function parseJson(text: string, operation: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubV4RemoteError(operation, 200, `GitHub ${operation} returned invalid JSON`);
  }
}

function parseContentsPayload(value: unknown, operation: string): ContentsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubV4RemoteError(operation, 200, `GitHub ${operation} returned an invalid file envelope`);
  }
  const payload = value as GitHubContentsPayload;
  if (typeof payload.content !== "string") {
    throw new GitHubV4RemoteError(operation, 200, `GitHub ${operation} returned no base64 content`);
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(payload.content);
  } catch {
    throw new GitHubV4RemoteError(operation, 200, `GitHub ${operation} returned invalid base64 content`);
  }
  return { bytes, blobSha: getString(payload.sha) };
}

function contentPath(owner: string, repo: string, path: string): string {
  const encodedPath = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
}

function blobPath(owner: string, repo: string, blobSha: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(blobSha)}`;
}

function withRef(path: string, branch: string): string {
  return `${path}?ref=${encodeURIComponent(branch)}`;
}

export class GitHubV4Remote {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly apiBaseUrl: string;

  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(options: GitHubV4RemoteOptions) {
    if (!options || typeof options.owner !== "string" || options.owner.length === 0) throw new TypeError("GitHub owner is required");
    if (typeof options.repo !== "string" || options.repo.length === 0) throw new TypeError("GitHub repo is required");
    if (typeof options.token !== "string") throw new TypeError("GitHub token is required");
    this.owner = options.owner;
    this.repo = options.repo;
    this.branch = options.branch || "main";
    this.apiBaseUrl = (options.apiBaseUrl ?? options.baseUrl ?? GITHUB_V4_API).replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.retryDelayMs = options.retryDelayMs ?? 100;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new TypeError("GitHub request timeout must be positive");
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) throw new TypeError("GitHub retry delay must be non-negative");
  }

  private async request(path: string, init: RequestInit = {}, accept = GITHUB_V4_JSON_MEDIA_TYPE): Promise<Response> {
    const method = (init.method ?? "GET").toString().toUpperCase();
    const canRetry = method === "GET";
    for (let attempt = 0; attempt < (canRetry ? 2 : 1); attempt += 1) {
      const headers = new Headers(init.headers);
      headers.set("Accept", accept);
      headers.set("Authorization", `Bearer ${this.token}`);
      headers.set("X-GitHub-Api-Version", GITHUB_V4_API_VERSION);
      const controller = new AbortController();
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let response: Response;
      try {
        response = await Promise.race([
          this.fetchImpl(`${this.apiBaseUrl}${path}`, { ...init, headers, signal: controller.signal }),
          new Promise<Response>((_, reject) => {
            timeoutTimer = setTimeout(() => {
              controller.abort();
              reject(new GitHubV4RemoteError(`${method} ${path}`, 0, "GitHub request timed out"));
            }, this.timeoutMs);
          }),
        ]);
      } catch (error) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (canRetry && attempt === 0) {
          if (this.retryDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
          continue;
        }
        if (error instanceof GitHubV4RemoteError) throw error;
        throw new GitHubV4RemoteError(`${method} ${path}`, 0, "GitHub network request failed");
      }
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (canRetry && attempt === 0 && (response.status === 502 || response.status === 503 || response.status === 504)) {
        if (this.retryDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
        continue;
      }
      return response;
    }
    throw new GitHubV4RemoteError(`${method} ${path}`, 0, "GitHub request failed");
  }

  private async requireOk(response: Response, operation: string): Promise<void> {
    if (!response.ok) throw new GitHubV4RemoteError(operation, response.status);
  }

  private async readContents(path: string): Promise<ContentsFile> {
    const response = await this.request(withRef(contentPath(this.owner, this.repo, path), this.branch), { method: "GET" });
    await this.requireOk(response, `read ${path}`);
    const payload = parseJson(await response.text(), `read ${path}`);
    return parseContentsPayload(payload, `read ${path}`);
  }

  /**
   * Read the sole mutable v4 object.  Supplying the previous result's cache
   * sends If-None-Match and turns a 304 into a cache hit without another GET.
   */
  async readHead(cache?: SyncV4HeadCache | SyncHeadV4): Promise<SyncV4HeadReadResult> {
    const previous = normalizeCache(cache);
    const headers = new Headers();
    if (previous?.etag) headers.set("If-None-Match", previous.etag);
    const response = await this.request(
      withRef(contentPath(this.owner, this.repo, SYNC_V4_HEAD_PATH), this.branch),
      { method: "GET", headers },
    );
    if (response.status === 304) {
      if (!previous) throw new GitHubV4RemoteError("read v4 head (304 without cache)", 304);
      const etag = response.headers.get("etag") ?? previous.etag;
      const cached = cacheFrom(previous.head, etag ?? undefined, previous.blobSha);
      return {
        status: "not-modified",
        kind: "cached",
        initialized: true,
        fromCache: true,
        head: cached.head,
        ...(cached.etag ? { etag: cached.etag } : {}),
        ...(cached.blobSha ? { blobSha: cached.blobSha } : {}),
        cache: cached,
      };
    }
    if (response.status === 404) {
      return { status: "missing", kind: "not-initialized", initialized: false, fromCache: false, head: null, cache: null };
    }
    await this.requireOk(response, "read v4 head");
    const payloadValue = parseJson(await response.text(), "read v4 head");
    const payload = payloadValue as GitHubContentsPayload;
    const file = parseContentsPayload(payloadValue, "read v4 head");
    let head: unknown;
    try {
      head = parseJson(new TextDecoder().decode(file.bytes), "decode v4 head");
    } catch {
      throw new GitHubV4RemoteError("decode v4 head", 200, "GitHub v4 head content is not valid JSON");
    }
    validateSyncHeadV4(head);
    const etag = response.headers.get("etag") ?? undefined;
    const blobSha = file.blobSha ?? extractBlobSha(payload);
    const resultCache = cacheFrom(head, etag, blobSha);
    return {
      status: "ok",
      kind: "found",
      initialized: true,
      fromCache: false,
      head,
      ...(etag ? { etag } : {}),
      ...(blobSha ? { blobSha } : {}),
      cache: resultCache,
    };
  }

  /** Update/create head.json using the Contents API's blob-SHA CAS field. */
  async putHead(head: SyncHeadV4, expected?: string | PutSyncV4HeadOptions | SyncV4HeadCache | SyncV4HeadReadResult): Promise<SyncV4HeadPutResult> {
    validateSyncHeadV4(head);
    let expectedSha: string | undefined;
    let message = "sync(v4): update head";
    if (typeof expected === "string") expectedSha = expected;
    else if (expected && "head" in expected) expectedSha = expected.blobSha;
    else if (expected) {
      expectedSha = expected.expectedSha ?? expected.sha;
      if (expected.message) message = expected.message;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(head));
    const body: Record<string, unknown> = {
      message,
      content: encodeBase64(bytes),
      branch: this.branch,
    };
    if (expectedSha) body.sha = expectedSha;
    const response = await this.request(contentPath(this.owner, this.repo, SYNC_V4_HEAD_PATH), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 409 || response.status === 422) {
      return { ok: false, reason: "cas-conflict", status: response.status, ...(expectedSha ? { expectedSha } : {}) };
    }
    await this.requireOk(response, "put v4 head");
    const payload = parseJson(await response.text(), "put v4 head");
    const blobSha = extractBlobSha(payload);
    if (!blobSha) throw new GitHubV4RemoteError("put v4 head", response.status, "GitHub did not return the new head blob SHA");
    const etag = response.headers.get("etag") ?? undefined;
    return {
      ok: true,
      status: response.status,
      head,
      blobSha,
      ...(etag ? { etag } : {}),
      cache: cacheFrom(head, etag, blobSha),
    };
  }

  /** Alias with CAS in the method name for callers that prefer explicitness. */
  putHeadCas(head: SyncHeadV4, expected?: string | PutSyncV4HeadOptions | SyncV4HeadCache | SyncV4HeadReadResult): Promise<SyncV4HeadPutResult> {
    return this.putHead(head, expected);
  }

  private normalizeImmutableInput(
    inputOrPath: SyncV4ImmutableFileInput | string,
    bytes?: ImmutableBytes,
    options?: Omit<SyncV4ImmutableFileInput, "path" | "bytes">,
  ): SyncV4ImmutableFileInput {
    if (typeof inputOrPath === "string") {
      if (bytes === undefined) throw new TypeError("immutable v4 file bytes are required");
      return { path: inputOrPath, bytes, ...options };
    }
    if (!inputOrPath || typeof inputOrPath.path !== "string") throw new TypeError("immutable v4 file path is required");
    return inputOrPath;
  }

  /**
   * Create an immutable content-addressed file.  A 422 from Contents PUT is
   * reconciled with one GET and succeeds only when the existing bytes match
   * exactly; a different file at the same path is never overwritten.
   */
  async putImmutable(input: SyncV4ImmutableFileInput): Promise<SyncV4ImmutablePutResult>;
  async putImmutable(path: string, bytes: ImmutableBytes, options?: Omit<SyncV4ImmutableFileInput, "path" | "bytes">): Promise<SyncV4ImmutablePutResult>;
  async putImmutable(
    inputOrPath: SyncV4ImmutableFileInput | string,
    bytes?: ImmutableBytes,
    options?: Omit<SyncV4ImmutableFileInput, "path" | "bytes">,
  ): Promise<SyncV4ImmutablePutResult> {
    const input = this.normalizeImmutableInput(inputOrPath, bytes, options);
    assertSafePath(input.path);
    assertKindPath(input.path, input.kind);
    const content = asBytes(input.bytes);
    const actualSize = content.byteLength;
    assertExpectedSize(actualSize, "immutable v4 file size");
    if (input.size !== undefined) {
      assertExpectedSize(input.size, "immutable v4 file size");
      if (input.size !== actualSize) throw new SyncV4BlobIntegrityError("size", input.size, actualSize);
    }
    const sha256 = await digestHex("SHA-256", content);
    const catalogDigest = archivePathDigest(input.path);
    if (catalogDigest && !sha256.startsWith(catalogDigest)) {
      throw new SyncV4BlobIntegrityError("sha256", `${catalogDigest}…`, sha256);
    }
    if (input.sha256 !== undefined) {
      assertDigest(input.sha256, "immutable v4 sha256");
      if (input.sha256 !== sha256) throw new SyncV4BlobIntegrityError("sha256", input.sha256, sha256);
    }
    const body = JSON.stringify({
      message: input.message ?? `sync(v4): add ${input.path}`,
      content: encodeBase64(content),
      branch: this.branch,
    });
    const response = await this.request(contentPath(this.owner, this.repo, input.path), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (response.status !== 422) {
      await this.requireOk(response, `put immutable ${input.path}`);
      const payload = parseJson(await response.text(), `put immutable ${input.path}`);
      const blobSha = extractBlobSha(payload);
      if (!blobSha) throw new GitHubV4RemoteError(`put immutable ${input.path}`, response.status, "GitHub did not return the blob SHA");
      return { path: input.path, blobSha, sha256, size: actualSize, created: response.status === 201, idempotent: false, status: response.status };
    }
    const existing = await this.readContents(input.path);
    if (!bytesEqual(existing.bytes, content)) throw new SyncV4ImmutableConflictError(input.path);
    let blobSha = existing.blobSha;
    if (!blobSha) {
      const header = new TextEncoder().encode(`blob ${actualSize}\0`);
      const blobBytes = new Uint8Array(header.byteLength + content.byteLength);
      blobBytes.set(header);
      blobBytes.set(content, header.byteLength);
      blobSha = await digestHex("SHA-1", blobBytes);
    }
    return { path: input.path, blobSha, sha256, size: actualSize, created: false, idempotent: true, status: response.status };
  }

  putImmutableFile(input: SyncV4ImmutableFileInput): Promise<SyncV4ImmutablePutResult>;
  putImmutableFile(path: string, bytes: ImmutableBytes, options?: Omit<SyncV4ImmutableFileInput, "path" | "bytes">): Promise<SyncV4ImmutablePutResult>;
  putImmutableFile(
    inputOrPath: SyncV4ImmutableFileInput | string,
    bytes?: ImmutableBytes,
    options?: Omit<SyncV4ImmutableFileInput, "path" | "bytes">,
  ): Promise<SyncV4ImmutablePutResult> {
    if (typeof inputOrPath === "string") {
      if (bytes === undefined) throw new TypeError("immutable v4 file bytes are required");
      return this.putImmutable(inputOrPath, bytes, options);
    }
    return this.putImmutable(inputOrPath);
  }

  uploadImmutable(input: SyncV4ImmutableFileInput): Promise<SyncV4ImmutablePutResult>;
  uploadImmutable(path: string, bytes: ImmutableBytes, options?: Omit<SyncV4ImmutableFileInput, "path" | "bytes">): Promise<SyncV4ImmutablePutResult>;
  uploadImmutable(
    inputOrPath: SyncV4ImmutableFileInput | string,
    bytes?: ImmutableBytes,
    options?: Omit<SyncV4ImmutableFileInput, "path" | "bytes">,
  ): Promise<SyncV4ImmutablePutResult> {
    if (typeof inputOrPath === "string") {
      if (bytes === undefined) throw new TypeError("immutable v4 file bytes are required");
      return this.putImmutable(inputOrPath, bytes, options);
    }
    return this.putImmutable(inputOrPath);
  }

  /** Read raw blob bytes by Git blob SHA and verify descriptor size/digest. */
  async readBlob(blobSha: string, expected: SyncV4BlobExpectation): Promise<Uint8Array>;
  async readBlob(descriptor: { blobSha: string; size: number; sha256: string }): Promise<Uint8Array>;
  async readBlob(
    blobShaOrDescriptor: string | { blobSha: string; size: number; sha256: string },
    expected?: SyncV4BlobExpectation,
  ): Promise<Uint8Array> {
    const blobSha = typeof blobShaOrDescriptor === "string" ? blobShaOrDescriptor : blobShaOrDescriptor.blobSha;
    const expectation = typeof blobShaOrDescriptor === "string" ? expected : blobShaOrDescriptor;
    if (!blobSha || typeof blobSha !== "string") throw new TypeError("blobSha is required");
    if (!expectation) throw new TypeError("blob size and sha256 are required");
    assertExpectedSize(expectation.size, "blob size");
    assertDigest(expectation.sha256, "blob sha256");
    const response = await this.request(blobPath(this.owner, this.repo, blobSha), { method: "GET" }, GITHUB_V4_RAW_MEDIA_TYPE);
    await this.requireOk(response, `read blob ${blobSha}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== expectation.size) throw new SyncV4BlobIntegrityError("size", expectation.size, bytes.byteLength);
    const actualSha256 = await digestHex("SHA-256", bytes);
    if (actualSha256 !== expectation.sha256) throw new SyncV4BlobIntegrityError("sha256", expectation.sha256, actualSha256);
    return bytes;
  }

  readImmutableBlob(blobSha: string, expected: SyncV4BlobExpectation): Promise<Uint8Array>;
  readImmutableBlob(descriptor: { blobSha: string; size: number; sha256: string }): Promise<Uint8Array>;
  readImmutableBlob(
    blobShaOrDescriptor: string | { blobSha: string; size: number; sha256: string },
    expected?: SyncV4BlobExpectation,
  ): Promise<Uint8Array> {
    return typeof blobShaOrDescriptor === "string"
      ? this.readBlob(blobShaOrDescriptor, expected as SyncV4BlobExpectation)
      : this.readBlob(blobShaOrDescriptor);
  }
}

export function createGitHubV4Remote(options: GitHubV4RemoteOptions): GitHubV4Remote {
  return new GitHubV4Remote(options);
}

/** Capitalisation alias retained for callers that spell GitHub as Github. */
export const createGithubV4Remote = createGitHubV4Remote;

export async function readSyncV4Head(
  options: GitHubV4RemoteOptions,
  cache?: SyncV4HeadCache | SyncHeadV4,
): Promise<SyncV4HeadReadResult> {
  return createGitHubV4Remote(options).readHead(cache);
}

export async function putSyncV4Head(
  options: GitHubV4RemoteOptions,
  head: SyncHeadV4,
  expected?: string | PutSyncV4HeadOptions | SyncV4HeadCache | SyncV4HeadReadResult,
): Promise<SyncV4HeadPutResult> {
  return createGitHubV4Remote(options).putHead(head, expected);
}

export async function putSyncV4ImmutableFile(
  options: GitHubV4RemoteOptions,
  input: SyncV4ImmutableFileInput,
): Promise<SyncV4ImmutablePutResult> {
  return createGitHubV4Remote(options).putImmutable(input);
}

export async function readSyncV4Blob(
  options: GitHubV4RemoteOptions,
  blobSha: string,
  expected: SyncV4BlobExpectation,
): Promise<Uint8Array> {
  return createGitHubV4Remote(options).readBlob(blobSha, expected);
}
