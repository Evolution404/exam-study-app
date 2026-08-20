/**
 * Immutable-ref offloading for v7 sync events.
 *
 * A change-set is the atomic unit of the journal and its encoded form must
 * fit inside a bounded segment (SYNC_V7_MAX_EVENT_BYTES, 256 KiB). A
 * change-set body — a large import, a practice run carrying hundreds of
 * answers — can be far larger than that ceiling. Rather than raise the
 * ceiling (which only postpones the wall) or split the atomic unit, a
 * change-set whose body exceeds the inline budget is *offloaded*: the body is
 * published as a content-addressed immutable object under
 * sync/v8/objects/<sha256>.json, and the segment event becomes a thin stub
 * carrying only the ordering/dedup metadata plus a `payloadRef` to that object.
 *
 * This is transport-only. The local Dexie change-set record always keeps the
 * full body — offload happens at wire encode (push), hydration at wire decode
 * (pull), so the domain reducer (reduceChangeSetV7) never observes a stub.
 */
import {
  SYNC_V7_OBJECT_PREFIX,
  createSyncV7ObjectRef,
  type SyncV7ImmutableRef,
  type SyncV7PublicationFile,
} from "./sync-v7-head";

/**
 * Change-sets at or below this many UTF-8 bytes travel inline in their segment.
 * Anything larger is offloaded to a content-addressed immutable object, whose
 * only ceiling is SYNC_V7_MAX_OBJECT_BYTES (32 MiB) — orders of magnitude above
 * the per-event wall the inline path enforces. The budget sits well under the
 * 256 KiB hard limit so inline events never threaten it.
 */
export const SYNC_V7_INLINE_EVENT_BUDGET = 128 * 1024;

/**
 * Small, cheap fields preserved on an offloaded stub so that ordering, dedup
 * and UI diagnostics still work without resolving the body. The heavy
 * `mutations`/`entityRefs` stay in the immutable object.
 */
const STUB_METADATA_KEYS = ["formatVersion", "id", "deviceId", "localSequence", "createdAt", "kind", "digest"] as const;

export interface SyncV7OffloadResult {
  /** Wire events: each is either the full event (inline) or a stub (offloaded). */
  events: Array<Record<string, unknown>>;
  /** Immutable object files to publish alongside the segments. */
  objects: SyncV7PublicationFile[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toUint8Array(bytes: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof bytes === "string") return encoder.encode(bytes);
  return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
}

/** Extract the immutable ref from a wire event, or undefined when it is inline. */
export function offloadedRefOf(event: unknown): SyncV7ImmutableRef | undefined {
  if (typeof event !== "object" || event === null || !("payloadRef" in event)) return undefined;
  const candidate = (event as { payloadRef?: unknown }).payloadRef;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const ref = candidate as Record<string, unknown>;
  if (typeof ref.path !== "string" || typeof ref.sha256 !== "string" || typeof ref.size !== "number") return undefined;
  const kind = typeof ref.kind === "string" ? (ref.kind as "object" | "asset") : "object";
  return { path: ref.path, sha256: ref.sha256, size: ref.size, kind, ...(typeof ref.blobSha === "string" ? { blobSha: ref.blobSha } : {}) };
}

/** True iff this wire event is a stub whose body was offloaded. */
export function isOffloadedSyncV7Event(event: unknown): boolean {
  return offloadedRefOf(event) !== undefined;
}

/**
 * Offload large change-set bodies into immutable objects. Returns the wire
 * events (inline or stub) plus the object files that must be published in the
 * same publication plan, before the segments. Idempotent: identical bodies
 * hash to identical paths, so re-publication of the same body never conflicts.
 */
export async function offloadSyncV7Events(
  events: readonly Record<string, unknown>[],
  budget: number = SYNC_V7_INLINE_EVENT_BUDGET,
): Promise<SyncV7OffloadResult> {
  const wire: Array<Record<string, unknown>> = [];
  const objects: SyncV7PublicationFile[] = [];
  for (const event of events) {
    const bytes = encoder.encode(JSON.stringify(event));
    if (bytes.byteLength <= budget) {
      wire.push(event);
      continue;
    }
    const sha256 = await sha256Hex(bytes);
    const path = `${SYNC_V7_OBJECT_PREFIX}${sha256}.json`;
    const ref = createSyncV7ObjectRef(path, sha256, bytes.byteLength, "object");
    objects.push({ path, bytes, kind: "object" });
    const stub: Record<string, unknown> = { payloadRef: ref };
    for (const key of STUB_METADATA_KEYS) {
      if (event[key] !== undefined) stub[key] = event[key];
    }
    wire.push(stub);
  }
  return { events: wire, objects };
}

/**
 * Hydrate wire events back into full change-sets. Inline events pass through;
 * stubs are resolved by fetching their immutable object and verifying its
 * content hash and size. The caller supplies the fetcher (the v8 remote
 * reading by content-addressed path), keeping this module transport-agnostic
 * and unit-testable without a network.
 */
export async function hydrateSyncV7Events<T>(
  events: readonly T[],
  fetchObject: (ref: SyncV7ImmutableRef) => Promise<Uint8Array | ArrayBuffer | string>,
): Promise<T[]> {
  const result: T[] = [];
  for (const event of events) {
    const ref = offloadedRefOf(event);
    if (!ref) {
      result.push(event);
      continue;
    }
    const raw = toUint8Array(await fetchObject(ref));
    const digest = await sha256Hex(raw);
    if (digest !== ref.sha256 || raw.byteLength !== ref.size) {
      throw new Error(`v8 immutable object ${ref.path} failed its sha256/size integrity check`);
    }
    result.push(JSON.parse(decoder.decode(raw)) as T);
  }
  return result;
}
