/**
 * Current sync transport contract.
 *
 * Domain/database names stay version-neutral. The remote wire protocol uses
 * format 10: head, checkpoints, objects, segments, assets and history all live
 * below sync/v10, and head/segment envelopes carry formatVersion 10.
 */

export const SYNC_FORMAT_VERSION = 10 as const;
export const SYNC_HEAD_PATH = "sync/v10/head.json";
export const SYNC_CHECKPOINT_PREFIX = "sync/v10/checkpoints/";
export const SYNC_OBJECT_PREFIX = "sync/v10/objects/";
export const SYNC_HISTORY_PREFIX = "sync/v10/history/";
export const SYNC_SEGMENT_PREFIX = "sync/v10/segments/";
export const SYNC_ASSET_PREFIX = "sync/v10/assets/";

/** The maximum encoded inline event. Larger payloads must be immutable refs. */
export const SYNC_MAX_EVENT_BYTES = 256 * 1024;
/** A hot segment is bounded independently of the aggregate hot window. */
export const SYNC_MAX_SEGMENT_BYTES = 1024 * 1024;
export const SYNC_MAX_SEGMENT_EVENT_COUNT = 250;
export const SYNC_MAX_HOT_SEGMENT_BYTES = SYNC_MAX_SEGMENT_BYTES;
export const SYNC_MAX_EVENT_PAGE_BYTES = SYNC_MAX_SEGMENT_BYTES;
export const SYNC_MAX_EVENT_PAGE_COUNT = SYNC_MAX_SEGMENT_EVENT_COUNT;
export const SYNC_MAX_SEGMENT_COUNT = 4096;
/** Checkpointing is driven by bytes, never by page count or CAS retries. */
export const SYNC_MAX_HOT_BYTES = 4 * 1024 * 1024;
export const SYNC_MAX_HOT_EVENT_BYTES = SYNC_MAX_HOT_BYTES;
export const SYNC_MAX_DESCRIPTOR_BYTES = 32 * 1024 * 1024;
export const SYNC_MAX_OBJECT_BYTES = SYNC_MAX_DESCRIPTOR_BYTES;
export const SYNC_MAX_PATH_LENGTH = 512;
export const SYNC_MAX_VAULT_ID_LENGTH = 256;
export const SYNC_MAX_DEVICE_CURSORS = 256;
export const SYNC_MAX_DEVICE_ID_LENGTH = 128;

export const SYNC_LIMITS = Object.freeze({
  maxEventBytes: SYNC_MAX_EVENT_BYTES,
  maxSegmentBytes: SYNC_MAX_SEGMENT_BYTES,
  maxSegmentEventCount: SYNC_MAX_SEGMENT_EVENT_COUNT,
  maxSegmentCount: SYNC_MAX_SEGMENT_COUNT,
  maxHotBytes: SYNC_MAX_HOT_BYTES,
  maxDescriptorBytes: SYNC_MAX_DESCRIPTOR_BYTES,
  maxPathLength: SYNC_MAX_PATH_LENGTH,
  maxVaultIdLength: SYNC_MAX_VAULT_ID_LENGTH,
  maxDeviceCursors: SYNC_MAX_DEVICE_CURSORS,
});

export type SyncBytes = Uint8Array | ArrayBuffer | string;

export interface SyncDescriptor {
  /** Relative Git path in one of the immutable current sync namespaces. */
  path: string;
  /** Git's SHA-1 blob id returned by the Contents API. */
  blobSha: string;
  /** SHA-256 of the exact (uncompressed) bytes represented by this object. */
  sha256: string;
  /** Size of the exact (uncompressed) bytes represented by this object. */
  size: number;
  /** ACTUAL stored/wire bytes (the DEFLATE envelope). */
  storedSize: number;
  /** Publication generation at which this checkpoint snapshot was written. */
  generation?: number;
}

export interface SyncHeadMetadata {
  /** Repeated in metadata so a decoded head cannot be detached from its vault. */
  vaultId: string;
  /** Device which last published this head, when known. */
  deviceId?: string;
  /** Optional producer label for forward-compatible diagnostics. */
  producer?: string;
}

export interface SyncSegmentMetadata {
  vaultId: string;
  createdAt: string;
  /** Optional producer/device label; cursor values remain authoritative. */
  deviceId?: string;
  producer?: string;
}

export interface SyncSegmentDescriptor extends SyncDescriptor {
  /** Replay key. It is intentionally independent of path/hash. */
  generation: number;
  /** Replay tie-breaker within a generation. */
  ordinal: number;
  count: number;
  /** Highest observed local sequence per device in this segment. */
  cursors: Record<string, number>;
  metadata: SyncSegmentMetadata;
}

export interface SyncDeviceWatermark {
  /** The install watermark this device last reported (its installedCursors). */
  cursors: Record<string, number>;
  /** When that watermark was published; devices silent for too long retire. */
  syncedAt: string;
}

export interface SyncHead {
  formatVersion: typeof SYNC_FORMAT_VERSION;
  /** Explicit logical vault identity; never infer this from a repository name. */
  vaultId: string;
  generatedAt: string;
  /** Monotonic publication generation (not a replay ordering substitute). */
  generation: number;
  metadata: SyncHeadMetadata;
  /** Null is permitted only for an uninitialised vault. */
  checkpoint: SyncDescriptor | null;
  segments: SyncSegmentDescriptor[];
  cursors: Record<string, number>;
  /** Per-device install watermarks for causally-stable tombstone GC. Optional
   * until the first device reports (absent = every device unconfirmed). */
  devices?: Record<string, SyncDeviceWatermark>;
}

export type SyncHeadDescriptor = SyncDescriptor;
export type SyncEventSegmentDescriptor = SyncSegmentDescriptor;
export type SyncHotSegmentDescriptor = SyncSegmentDescriptor;
export type SyncLocalCheckpointDescriptor = SyncDescriptor;
export type SyncObjectDescriptor = SyncDescriptor;

/** A reference used inside an event when the payload is too large to inline. */
export interface SyncImmutableRef {
  path: string;
  sha256: string;
  size: number;
  kind: "object" | "asset";
  /** Filled after upload; omitted in an event awaiting publication. */
  blobSha?: string;
}
export type SyncBlobRef = SyncImmutableRef;

export interface SyncSegment<T = unknown> {
  formatVersion: typeof SYNC_FORMAT_VERSION;
  vaultId: string;
  generation: number;
  ordinal: number;
  metadata: SyncSegmentMetadata;
  cursors: Record<string, number>;
  events: T[];
}

export interface SyncEncodedSegment<T = unknown> {
  segment: SyncSegment<T>;
  bytes: Uint8Array;
  size: number;
  count: number;
}

export interface SyncReplaySegment<T = unknown> {
  generation: number;
  ordinal: number;
  events: readonly T[];
  path?: string;
  metadata?: SyncSegmentMetadata;
}

export type SyncDescriptorKind = "checkpoint" | "object" | "segment" | "asset" | "history";

export interface SyncPublicationFile {
  path: string;
  bytes: SyncBytes;
  kind?: SyncDescriptorKind;
  /**
   * The file's bytes are already present on the remote (uploaded out-of-band to
   * obtain its descriptor, e.g. via `uploadedDescriptor`). `publish` must not
   * re-upload it; it only needs to exist when the head is written.
   */
  uploaded?: boolean;
}

export interface SyncPublicationPlan {
  objects: SyncPublicationFile[];
  segments: SyncPublicationFile[];
  /** Present only for initialization or an actual byte-window overflow. */
  checkpoint?: SyncPublicationFile;
  head: SyncHead;
  expectedHeadSha?: string;
  order: readonly ["objects", "segments", "head-cas"] | readonly ["checkpoint", "objects", "segments", "head-cas"];
  mode: "append" | "compaction";
}

export interface SyncCompactionPlan {
  required: boolean;
  reason: "none" | "initialization" | "hot-window-overflow";
  hotBytes: number;
  /** This is a diagnostic only; it never participates in the decision. */
  segmentCount: number;
  checkpointAllowed: boolean;
}

export interface SyncAppendPublicationInput {
  expectedHead: SyncHead;
  head: SyncHead;
  objects?: readonly SyncPublicationFile[];
  segments?: readonly SyncPublicationFile[];
  expectedHeadSha?: string;
}
