import {
  SYNC_V6_ARCHIVE_CATALOG_PREFIX,
  SYNC_V6_ARCHIVE_PREFIX,
  SYNC_V6_ASSET_PREFIX,
  SYNC_V6_CHECKPOINT_PREFIX,
  SYNC_V6_EVENT_PREFIX,
  SYNC_V6_HEAD_PATH,
  SYNC_V6_IMMUTABLE_PREFIX,
  SYNC_V6_MAX_DESCRIPTOR_BYTES,
  SYNC_V6_MAX_EVENT_PAGE_BYTES,
  assertSyncV6Path,
  validateSyncHeadV6,
} from "./sync-v6-head";
import type {
  SyncHeadV6,
  SyncV6Descriptor,
  SyncV6DescriptorKind,
  SyncV6PublicationFile,
  SyncV6PublicationPlan,
} from "./sync-v6-head";

export const GITHUB_V6_API = "https://api.github.com";
export const GITHUB_V6_JSON_MEDIA_TYPE = "application/vnd.github+json";
export const GITHUB_V6_RAW_MEDIA_TYPE = "application/vnd.github.raw+json";
export const GITHUB_V6_API_VERSION = "2022-11-28";

export interface GitHubV6RemoteOptions {
  owner: string;
  repo: string;
  token: string;
  branch?: string;
  apiBaseUrl?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
}

export interface SyncV6HeadCache {
  head: SyncHeadV6;
  etag?: string;
  blobSha?: string;
}

export type SyncV6HeadReadResult =
  | {
      status: "ok";
      kind: "found";
      initialized: true;
      fromCache: false;
      head: SyncHeadV6;
      etag?: string;
      blobSha?: string;
      cache: SyncV6HeadCache;
    }
  | {
      status: "not-modified";
      kind: "cached";
      initialized: true;
      fromCache: true;
      head: SyncHeadV6;
      etag?: string;
      blobSha?: string;
      cache: SyncV6HeadCache;
    }
  | {
      status: "missing";
      kind: "not-initialized";
      initialized: false;
      fromCache: false;
      head: null;
      cache: null;
    };

export interface PutSyncV6HeadOptions {
  expectedSha?: string;
  sha?: string;
  message?: string;
}

export interface SyncV6HeadPutSuccess {
  ok: true;
  status: number;
  head: SyncHeadV6;
  blobSha: string;
  etag?: string;
  cache: SyncV6HeadCache;
}

export interface SyncV6HeadPutConflict {
  ok: false;
  reason: "cas-conflict";
  /** HTTP status is retained so callers can distinguish a race (409) from an existing head (422). */
  status: 409 | 422;
  classification: "head-advanced" | "head-already-exists";
  conflict: "changed" | "already-exists";
  expectedSha?: string;
}

export type SyncV6HeadPutResult = SyncV6HeadPutSuccess | SyncV6HeadPutConflict;

export type SyncV6ImmutableBytes = Uint8Array | ArrayBuffer | string;

export interface SyncV6ImmutableFileInput {
  path: string;
  bytes: SyncV6ImmutableBytes;
  kind?: SyncV6DescriptorKind;
  sha256?: string;
  size?: number;
  message?: string;
}

export interface SyncV6ImmutablePutResult {
  path: string;
  blobSha: string;
  sha256: string;
  size: number;
  created: boolean;
  idempotent: boolean;
  status: number;
}

export interface SyncV6BlobExpectation {
  size: number;
  sha256: string;
}

export class GitHubV6RemoteError extends Error {
  readonly status: number;
  readonly operation: string;

  constructor(operation: string, status: number, message?: string) {
    super(message ?? `GitHub ${operation} failed (${status})`);
    this.name = "GitHubV6RemoteError";
    this.status = status;
    this.operation = operation;
  }
}

export class SyncV6ImmutableConflictError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`immutable v6 file content differs at ${path}`);
    this.name = "SyncV6ImmutableConflictError";
    this.path = path;
  }
}

export class SyncV6BlobIntegrityError extends Error {
  readonly reason: "size" | "sha256";
  readonly expected: number | string;
  readonly actual: number | string;

  constructor(reason: "size" | "sha256", expected: number | string, actual: number | string) {
    super(reason === "size"
      ? `v6 blob size mismatch: expected ${expected}, received ${actual}`
      : `v6 blob sha256 mismatch: expected ${expected}, received ${actual}`);
    this.name = "SyncV6BlobIntegrityError";
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

function asBytes(value: SyncV6ImmutableBytes): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new TypeError("immutable v6 file bytes must be text, Uint8Array, or ArrayBuffer");
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
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

function digestHex(algorithm: AlgorithmIdentifier, bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest(algorithm, bytes as BufferSource).then((digest) => (
    Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")
  ));
}

function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
}

function assertSha1(value: string, field: string): void {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new TypeError(`${field} must be a lowercase Git SHA-1 blob id`);
}

function assertExpectedSize(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractBlobSha(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as { content?: unknown; sha?: unknown; existingSha?: unknown };
  if (typeof object.existingSha === "string") return object.existingSha;
  if (object.content && typeof object.content === "object" && !Array.isArray(object.content)) {
    return getString((object.content as { sha?: unknown }).sha);
  }
  return getString(object.sha);
}

function parseJson(text: string, operation: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubV6RemoteError(operation, 200, `GitHub ${operation} returned invalid JSON`);
  }
}

function parseContentsPayload(value: unknown, operation: string): ContentsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubV6RemoteError(operation, 200, `GitHub ${operation} returned an invalid file envelope`);
  }
  const payload = value as GitHubContentsPayload;
  if (typeof payload.content !== "string") throw new GitHubV6RemoteError(operation, 200, `GitHub ${operation} returned no base64 content`);
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(payload.content);
  } catch {
    throw new GitHubV6RemoteError(operation, 200, `GitHub ${operation} returned invalid base64 content`);
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

function normalizeCache(cache: SyncV6HeadCache | SyncHeadV6 | undefined): SyncV6HeadCache | undefined {
  if (!cache) return undefined;
  if ("formatVersion" in cache) {
    validateSyncHeadV6(cache);
    return { head: cache };
  }
  validateSyncHeadV6(cache.head);
  if (cache.blobSha !== undefined) assertSha1(cache.blobSha, "cached head blobSha");
  return { head: cache.head, etag: cache.etag, blobSha: cache.blobSha };
}

function cacheFrom(head: SyncHeadV6, etag?: string, blobSha?: string): SyncV6HeadCache {
  validateSyncHeadV6(head);
  if (blobSha !== undefined) assertSha1(blobSha, "head blobSha");
  return { head, ...(etag ? { etag } : {}), ...(blobSha ? { blobSha } : {}) };
}

export class GitHubV6Remote {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly apiBaseUrl: string;

  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(options: GitHubV6RemoteOptions) {
    if (!options || typeof options.owner !== "string" || options.owner.length === 0) throw new TypeError("GitHub owner is required");
    if (typeof options.repo !== "string" || options.repo.length === 0) throw new TypeError("GitHub repo is required");
    if (typeof options.token !== "string") throw new TypeError("GitHub token is required");
    this.owner = options.owner;
    this.repo = options.repo;
    this.branch = options.branch || "main";
    this.apiBaseUrl = (options.apiBaseUrl ?? options.baseUrl ?? GITHUB_V6_API).replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    // A content-addressed checkpoint for several thousand questions is a
    // multi-megabyte upload.  Twelve seconds was sufficient for head/event
    // traffic but caused safe, repeatable timeouts while publishing the first
    // real v6 checkpoint.  Keep a finite timeout while allowing normal GitHub
    // latency for large immutable objects.
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.retryDelayMs = options.retryDelayMs ?? 100;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new TypeError("GitHub request timeout must be positive");
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) throw new TypeError("GitHub retry delay must be non-negative");
  }

  private async request(path: string, init: RequestInit = {}, accept = GITHUB_V6_JSON_MEDIA_TYPE): Promise<Response> {
    const method = (init.method ?? "GET").toString().toUpperCase();
    const canRetry = method === "GET";
    for (let attempt = 0; attempt < (canRetry ? 2 : 1); attempt += 1) {
      const headers = new Headers(init.headers);
      headers.set("Accept", accept);
      headers.set("Authorization", `Bearer ${this.token}`);
      headers.set("X-GitHub-Api-Version", GITHUB_V6_API_VERSION);
      const controller = new AbortController();
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let response: Response;
      try {
        response = await Promise.race([
          this.fetchImpl(`${this.apiBaseUrl}${path}`, { ...init, headers, signal: controller.signal }),
          new Promise<Response>((_, reject) => {
            timeoutTimer = setTimeout(() => {
              controller.abort();
              reject(new GitHubV6RemoteError(`${method} ${path}`, 0, "GitHub request timed out"));
            }, this.timeoutMs);
          }),
        ]);
      } catch (error) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (canRetry && attempt === 0) {
          if (this.retryDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
          continue;
        }
        if (error instanceof GitHubV6RemoteError) throw error;
        throw new GitHubV6RemoteError(`${method} ${path}`, 0, "GitHub network request failed");
      }
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (canRetry && attempt === 0 && (response.status === 502 || response.status === 503 || response.status === 504)) {
        if (this.retryDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
        continue;
      }
      return response;
    }
    throw new GitHubV6RemoteError(`${method} ${path}`, 0, "GitHub request failed");
  }

  private requireOk(response: Response, operation: string): void {
    if (!response.ok) throw new GitHubV6RemoteError(operation, response.status);
  }

  /**
   * Resolve an existing immutable path to its Git blob id without assuming
   * that Contents returned inline bytes. GitHub may send `encoding: none`
   * (and an empty `content`) for larger files; the bytes are always fetched
   * and verified separately through the authenticated blob endpoint.
   */
  private async readContentsMetadata(path: string): Promise<string> {
    const response = await this.request(withRef(contentPath(this.owner, this.repo, path), this.branch), { method: "GET" });
    this.requireOk(response, `read metadata ${path}`);
    const payload = parseJson(await response.text(), `read metadata ${path}`);
    const blobSha = extractBlobSha(payload);
    if (!blobSha) throw new GitHubV6RemoteError(`read metadata ${path}`, 200, "GitHub did not return an existing blob SHA");
    assertSha1(blobSha, "existing immutable blobSha");
    return blobSha;
  }

  /**
   * Read an immutable content-addressed object by path without a blob SHA in
   * hand (e.g. a run definition referenced by an event): resolve the Git blob
   * id through Contents metadata, then fetch and integrity-verify the bytes.
   */
  async readImmutableContents(path: string, expected: SyncV6BlobExpectation): Promise<Uint8Array> {
    const blobSha = await this.readContentsMetadata(path);
    return this.readBlob(blobSha, expected);
  }

  /** Read the only mutable object through Contents GET and honor ETag/304. */
  async readHead(cache?: SyncV6HeadCache | SyncHeadV6): Promise<SyncV6HeadReadResult> {
    const previous = normalizeCache(cache);
    const headers = new Headers();
    if (previous?.etag) headers.set("If-None-Match", previous.etag);
    const response = await this.request(
      withRef(contentPath(this.owner, this.repo, SYNC_V6_HEAD_PATH), this.branch),
      { method: "GET", headers },
    );
    if (response.status === 304) {
      if (!previous) throw new GitHubV6RemoteError("read v6 head (304 without cache)", 304);
      const etag = response.headers.get("etag") ?? previous.etag;
      const cached = cacheFrom(previous.head, etag ?? undefined, previous.blobSha);
      return {
        status: "not-modified", kind: "cached", initialized: true, fromCache: true, head: cached.head,
        ...(cached.etag ? { etag: cached.etag } : {}), ...(cached.blobSha ? { blobSha: cached.blobSha } : {}), cache: cached,
      };
    }
    if (response.status === 404) return { status: "missing", kind: "not-initialized", initialized: false, fromCache: false, head: null, cache: null };
    this.requireOk(response, "read v6 head");
    const payloadValue = parseJson(await response.text(), "read v6 head");
    const file = parseContentsPayload(payloadValue, "read v6 head");
    let head: unknown;
    try {
      head = parseJson(new TextDecoder().decode(file.bytes), "decode v6 head");
    } catch {
      throw new GitHubV6RemoteError("decode v6 head", 200, "GitHub v6 head content is not valid JSON");
    }
    validateSyncHeadV6(head);
    const etag = response.headers.get("etag") ?? undefined;
    const blobSha = file.blobSha ?? extractBlobSha(payloadValue);
    const resultCache = cacheFrom(head, etag, blobSha);
    return { status: "ok", kind: "found", initialized: true, fromCache: false, head, ...(etag ? { etag } : {}), ...(blobSha ? { blobSha } : {}), cache: resultCache };
  }

  async putHead(head: SyncHeadV6, expected?: string | PutSyncV6HeadOptions | SyncV6HeadCache | SyncV6HeadReadResult): Promise<SyncV6HeadPutResult> {
    validateSyncHeadV6(head);
    let expectedSha: string | undefined;
    let message = "sync(v6): update head";
    if (typeof expected === "string") expectedSha = expected;
    else if (expected && "head" in expected) {
      expectedSha = "blobSha" in expected && typeof expected.blobSha === "string" ? expected.blobSha : undefined;
    }
    else if (expected) {
      expectedSha = expected.expectedSha ?? expected.sha;
      if (expected.message) message = expected.message;
    }
    if (expectedSha !== undefined) assertSha1(expectedSha, "expected head blobSha");
    const bytes = new TextEncoder().encode(JSON.stringify(head));
    const body: Record<string, unknown> = { message, content: encodeBase64(bytes), branch: this.branch };
    if (expectedSha) body.sha = expectedSha;
    const response = await this.request(contentPath(this.owner, this.repo, SYNC_V6_HEAD_PATH), {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (response.status === 409 || response.status === 422) {
      return {
        ok: false,
        reason: "cas-conflict",
        status: response.status,
        classification: response.status === 409 ? "head-advanced" : "head-already-exists",
        conflict: response.status === 409 ? "changed" : "already-exists",
        ...(expectedSha ? { expectedSha } : {}),
      };
    }
    this.requireOk(response, "put v6 head");
    const payload = parseJson(await response.text(), "put v6 head");
    const blobSha = extractBlobSha(payload);
    if (!blobSha) throw new GitHubV6RemoteError("put v6 head", response.status, "GitHub did not return the new head blob SHA");
    assertSha1(blobSha, "returned head blobSha");
    const etag = response.headers.get("etag") ?? undefined;
    return { ok: true, status: response.status, head, blobSha, ...(etag ? { etag } : {}), cache: cacheFrom(head, etag, blobSha) };
  }

  putHeadCas(head: SyncHeadV6, expected?: string | PutSyncV6HeadOptions | SyncV6HeadCache | SyncV6HeadReadResult): Promise<SyncV6HeadPutResult> {
    return this.putHead(head, expected);
  }

  private normalizeImmutableInput(inputOrPath: SyncV6ImmutableFileInput | string, bytes?: SyncV6ImmutableBytes, options?: Omit<SyncV6ImmutableFileInput, "path" | "bytes">): SyncV6ImmutableFileInput {
    if (typeof inputOrPath === "string") {
      if (bytes === undefined) throw new TypeError("immutable v6 file bytes are required");
      return { path: inputOrPath, bytes, ...options };
    }
    if (!inputOrPath || typeof inputOrPath.path !== "string") throw new TypeError("immutable v6 file path is required");
    return inputOrPath;
  }

  private maxSize(kind: SyncV6DescriptorKind | undefined): number {
    return kind === "eventPage" ? SYNC_V6_MAX_EVENT_PAGE_BYTES : SYNC_V6_MAX_DESCRIPTOR_BYTES;
  }

  async putImmutable(input: SyncV6ImmutableFileInput): Promise<SyncV6ImmutablePutResult>;
  async putImmutable(path: string, bytes: SyncV6ImmutableBytes, options?: Omit<SyncV6ImmutableFileInput, "path" | "bytes">): Promise<SyncV6ImmutablePutResult>;
  async putImmutable(inputOrPath: SyncV6ImmutableFileInput | string, bytes?: SyncV6ImmutableBytes, options?: Omit<SyncV6ImmutableFileInput, "path" | "bytes">): Promise<SyncV6ImmutablePutResult> {
    const input = this.normalizeImmutableInput(inputOrPath, bytes, options);
    const kind = input.kind ?? inferKind(input.path);
    assertSyncV6Path(input.path, kind);
    const content = asBytes(input.bytes);
    const actualSize = content.byteLength;
    assertExpectedSize(actualSize, "immutable v6 file size");
    if (actualSize > this.maxSize(kind)) throw new TypeError(`immutable v6 ${kind} exceeds its byte safety limit`);
    if (input.size !== undefined) {
      assertExpectedSize(input.size, "immutable v6 file size");
      if (input.size !== actualSize) throw new SyncV6BlobIntegrityError("size", input.size, actualSize);
    }
    const sha256 = await digestHex("SHA-256", content);
    const pathHash = pathDigest(input.path);
    if (pathHash && pathHash !== sha256) throw new SyncV6BlobIntegrityError("sha256", pathHash, sha256);
    if (input.sha256 !== undefined) {
      assertSha256(input.sha256, "immutable v6 sha256");
      if (input.sha256 !== sha256) throw new SyncV6BlobIntegrityError("sha256", input.sha256, sha256);
    }
    const response = await this.request(contentPath(this.owner, this.repo, input.path), {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: input.message ?? `sync(v6): add ${input.path}`, content: encodeBase64(content), branch: this.branch }),
    });
    if (response.status !== 422) {
      this.requireOk(response, `put immutable ${input.path}`);
      const blobSha = extractBlobSha(parseJson(await response.text(), `put immutable ${input.path}`));
      if (!blobSha) throw new GitHubV6RemoteError(`put immutable ${input.path}`, response.status, "GitHub did not return the blob SHA");
      assertSha1(blobSha, "returned immutable blobSha");
      return { path: input.path, blobSha, sha256, size: actualSize, created: response.status === 201, idempotent: false, status: response.status };
    }

    // GitHub normally omits the existing SHA in a 422 body. A metadata-only
    // Contents GET obtains it; it must not assume inline base64 bytes because
    // large files are returned with encoding="none". The bytes themselves
    // are then read and verified only through Git Blob API.
    let existingSha: string | undefined;
    try {
      existingSha = extractBlobSha(parseJson(await response.text(), `put immutable ${input.path}`));
    } catch {
      // Empty/non-JSON 422 responses are common; fetch metadata below.
    }
    if (!existingSha) existingSha = await this.readContentsMetadata(input.path);
    if (!existingSha) throw new GitHubV6RemoteError(`reconcile immutable ${input.path}`, 422, "GitHub did not return the existing blob SHA");
    assertSha1(existingSha, "existing immutable blobSha");
    const existingBytes = await this.readBlob(existingSha, { size: actualSize, sha256 });
    if (!bytesEqual(existingBytes, content)) throw new SyncV6ImmutableConflictError(input.path);
    return { path: input.path, blobSha: existingSha, sha256, size: actualSize, created: false, idempotent: true, status: 422 };
  }

  putImmutableFile(input: SyncV6ImmutableFileInput): Promise<SyncV6ImmutablePutResult>;
  putImmutableFile(path: string, bytes: SyncV6ImmutableBytes, options?: Omit<SyncV6ImmutableFileInput, "path" | "bytes">): Promise<SyncV6ImmutablePutResult>;
  putImmutableFile(inputOrPath: SyncV6ImmutableFileInput | string, bytes?: SyncV6ImmutableBytes, options?: Omit<SyncV6ImmutableFileInput, "path" | "bytes">): Promise<SyncV6ImmutablePutResult> {
    return typeof inputOrPath === "string"
      ? this.putImmutable(inputOrPath, bytes as SyncV6ImmutableBytes, options)
      : this.putImmutable(inputOrPath);
  }

  uploadImmutable = this.putImmutable.bind(this) as GitHubV6Remote["putImmutable"];

  /** All immutable and asset reads go through the authenticated Git blob API. */
  async readBlob(blobSha: string, expected: SyncV6BlobExpectation): Promise<Uint8Array>;
  async readBlob(descriptor: SyncV6Descriptor): Promise<Uint8Array>;
  async readBlob(blobShaOrDescriptor: string | SyncV6Descriptor, expected?: SyncV6BlobExpectation): Promise<Uint8Array> {
    const blobSha = typeof blobShaOrDescriptor === "string" ? blobShaOrDescriptor : blobShaOrDescriptor.blobSha;
    const expectation = typeof blobShaOrDescriptor === "string" ? expected : blobShaOrDescriptor;
    if (!blobSha || !expectation) throw new TypeError("blob SHA, size and sha256 are required");
    if (typeof blobShaOrDescriptor !== "string") {
      assertSyncV6Path(blobShaOrDescriptor.path, inferKind(blobShaOrDescriptor.path));
    }
    assertSha1(blobSha, "blobSha");
    assertExpectedSize(expectation.size, "blob size");
    assertSha256(expectation.sha256, "blob sha256");
    const response = await this.request(blobPath(this.owner, this.repo, blobSha), { method: "GET" }, GITHUB_V6_RAW_MEDIA_TYPE);
    this.requireOk(response, `read blob ${blobSha}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== expectation.size) throw new SyncV6BlobIntegrityError("size", expectation.size, bytes.byteLength);
    const actualSha256 = await digestHex("SHA-256", bytes);
    if (actualSha256 !== expectation.sha256) throw new SyncV6BlobIntegrityError("sha256", expectation.sha256, actualSha256);
    return bytes;
  }

  readImmutableBlob(blobSha: string, expected: SyncV6BlobExpectation): Promise<Uint8Array>;
  readImmutableBlob(descriptor: SyncV6Descriptor): Promise<Uint8Array>;
  readImmutableBlob(blobShaOrDescriptor: string | SyncV6Descriptor, expected?: SyncV6BlobExpectation): Promise<Uint8Array> {
    return typeof blobShaOrDescriptor === "string" ? this.readBlob(blobShaOrDescriptor, expected as SyncV6BlobExpectation) : this.readBlob(blobShaOrDescriptor);
  }

  readAsset(descriptor: SyncV6Descriptor): Promise<Uint8Array> {
    assertSyncV6Path(descriptor.path, "asset");
    return this.readBlob(descriptor);
  }

  /** Execute the required assets -> immutable objects -> head CAS sequence. */
  async publish(plan: SyncV6PublicationPlan): Promise<SyncV6HeadPutResult> {
    for (const asset of plan.assets) await this.putPublicationFile(asset, "asset");
    for (const file of plan.immutable) await this.putPublicationFile(file, file.kind ?? "immutable");
    return this.putHead(plan.head, plan.expectedHeadSha);
  }

  private putPublicationFile(file: SyncV6PublicationFile, defaultKind: SyncV6DescriptorKind): Promise<SyncV6ImmutablePutResult> {
    return this.putImmutable({ path: file.path, bytes: file.bytes, kind: file.kind ?? defaultKind });
  }
}

function inferKind(path: string): SyncV6DescriptorKind {
  if (path.startsWith(SYNC_V6_ASSET_PREFIX)) return "asset";
  if (path.startsWith(SYNC_V6_CHECKPOINT_PREFIX)) return "checkpoint";
  if (path.startsWith(SYNC_V6_ARCHIVE_CATALOG_PREFIX)) return "archiveCatalog";
  if (path.startsWith(SYNC_V6_ARCHIVE_PREFIX)) return "archiveSegment";
  if (path.startsWith(SYNC_V6_EVENT_PREFIX)) return "eventPage";
  if (path.startsWith(SYNC_V6_IMMUTABLE_PREFIX)) return "immutable";
  throw new TypeError("immutable v6 path must be in a known namespace");
}

function pathDigest(path: string): string | undefined {
  return /\/([a-f0-9]{64})\.(?:json|webp|jpg|png)$/.exec(path)?.[1];
}

export function createGitHubV6Remote(options: GitHubV6RemoteOptions): GitHubV6Remote {
  return new GitHubV6Remote(options);
}

export const createGithubV6Remote = createGitHubV6Remote;

export async function readSyncV6Head(options: GitHubV6RemoteOptions, cache?: SyncV6HeadCache | SyncHeadV6): Promise<SyncV6HeadReadResult> {
  return createGitHubV6Remote(options).readHead(cache);
}

export async function putSyncV6Head(options: GitHubV6RemoteOptions, head: SyncHeadV6, expected?: string | PutSyncV6HeadOptions | SyncV6HeadCache | SyncV6HeadReadResult): Promise<SyncV6HeadPutResult> {
  return createGitHubV6Remote(options).putHead(head, expected);
}

export async function putSyncV6ImmutableFile(options: GitHubV6RemoteOptions, input: SyncV6ImmutableFileInput): Promise<SyncV6ImmutablePutResult> {
  return createGitHubV6Remote(options).putImmutable(input);
}

export async function readSyncV6Blob(options: GitHubV6RemoteOptions, blobSha: string, expected: SyncV6BlobExpectation): Promise<Uint8Array> {
  return createGitHubV6Remote(options).readBlob(blobSha, expected);
}
