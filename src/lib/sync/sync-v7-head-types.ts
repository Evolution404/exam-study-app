/**
 * Sync v9 transport contract.
 *
 * The domain/database model intentionally remains v7, so the long-lived
 * internal type/function names in this module still carry a V7 suffix.  The
 * wire protocol is nevertheless fully v9: head, checkpoints, objects,
 * segments, assets and history all live below sync/v9 and head/segment
 * envelopes carry formatVersion 9.
 */

export const SYNC_V9_FORMAT_VERSION = 9 as const;
export const SYNC_V9_HEAD_PATH = "sync/v9/head.json";
export const SYNC_V9_CHECKPOINT_PREFIX = "sync/v9/checkpoints/";
export const SYNC_V9_OBJECT_PREFIX = "sync/v9/objects/";
export const SYNC_V9_HISTORY_PREFIX = "sync/v9/history/";
export const SYNC_V9_SEGMENT_PREFIX = "sync/v9/segments/";
export const SYNC_V9_ASSET_PREFIX = "sync/v9/assets/";

/** Internal compatibility aliases. New code and architecture checks use v9. */
export const SYNC_V7_FORMAT_VERSION = SYNC_V9_FORMAT_VERSION;
export const SYNC_V7_HEAD_PATH = SYNC_V9_HEAD_PATH;
export const SYNC_V7_CHECKPOINT_PREFIX = SYNC_V9_CHECKPOINT_PREFIX;
export const SYNC_V7_OBJECT_PREFIX = SYNC_V9_OBJECT_PREFIX;
export const SYNC_V7_SEGMENT_PREFIX = SYNC_V9_SEGMENT_PREFIX;
export const SYNC_V7_ASSET_PREFIX = SYNC_V9_ASSET_PREFIX;
/** Naming aliases used by callers that call segments “hot segments”. */
export const SYNC_V7_HOT_SEGMENT_PREFIX = SYNC_V7_SEGMENT_PREFIX;
export const SYNC_V7_EVENT_SEGMENT_PREFIX = SYNC_V7_SEGMENT_PREFIX;

/** The maximum encoded inline event. Larger payloads must be immutable refs. */
export const SYNC_V7_MAX_EVENT_BYTES = 256 * 1024;
/** A hot segment is bounded independently of the aggregate hot window. */
export const SYNC_V7_MAX_SEGMENT_BYTES = 1024 * 1024;
export const SYNC_V7_MAX_SEGMENT_EVENT_COUNT = 250;
export const SYNC_V7_MAX_HOT_SEGMENT_BYTES = SYNC_V7_MAX_SEGMENT_BYTES;
export const SYNC_V7_MAX_EVENT_PAGE_BYTES = SYNC_V7_MAX_SEGMENT_BYTES;
export const SYNC_V7_MAX_EVENT_PAGE_COUNT = SYNC_V7_MAX_SEGMENT_EVENT_COUNT;
export const SYNC_V7_MAX_SEGMENT_COUNT = 4096;
/** Checkpointing is driven by bytes, never by page count or CAS retries. */
export const SYNC_V7_MAX_HOT_BYTES = 4 * 1024 * 1024;
export const SYNC_V7_MAX_HOT_EVENT_BYTES = SYNC_V7_MAX_HOT_BYTES;
export const SYNC_V7_MAX_DESCRIPTOR_BYTES = 32 * 1024 * 1024;
export const SYNC_V7_MAX_OBJECT_BYTES = SYNC_V7_MAX_DESCRIPTOR_BYTES;
export const SYNC_V7_MAX_PATH_LENGTH = 512;
export const SYNC_V7_MAX_VAULT_ID_LENGTH = 256;
export const SYNC_V7_MAX_DEVICE_CURSORS = 256;
export const SYNC_V7_MAX_DEVICE_ID_LENGTH = 128;

export const SYNC_V7_LIMITS = Object.freeze({
  maxEventBytes: SYNC_V7_MAX_EVENT_BYTES,
  maxSegmentBytes: SYNC_V7_MAX_SEGMENT_BYTES,
  maxSegmentEventCount: SYNC_V7_MAX_SEGMENT_EVENT_COUNT,
  maxSegmentCount: SYNC_V7_MAX_SEGMENT_COUNT,
  maxHotBytes: SYNC_V7_MAX_HOT_BYTES,
  maxDescriptorBytes: SYNC_V7_MAX_DESCRIPTOR_BYTES,
  maxPathLength: SYNC_V7_MAX_PATH_LENGTH,
  maxVaultIdLength: SYNC_V7_MAX_VAULT_ID_LENGTH,
  maxDeviceCursors: SYNC_V7_MAX_DEVICE_CURSORS,
});

export type SyncV7Bytes = Uint8Array | ArrayBuffer | string;

export interface SyncV7Descriptor {
  /** Relative Git path in one of the immutable v9 namespaces. */
  path: string;
  /** Git's SHA-1 blob id returned by the Contents API. */
  blobSha: string;
  /** SHA-256 of the exact (uncompressed) bytes represented by this object. */
  sha256: string;
  /** Size of the exact (uncompressed) bytes represented by this object. */
  size: number;
  /** ACTUAL stored/wire bytes (the DEFLATE envelope).  Optional because it is
   *  metadata added after the codec landed — legacy descriptors predate it,
   *  and every new upload fills it so readers can show real transfer sizes
   *  BEFORE downloading.  `size` stays the logical byte count by design
   *  (content addressing). */
  storedSize?: number;
  /** Publication generation at which this checkpoint snapshot was written. */
  generation?: number;
}

export interface SyncV7HeadMetadata {
  /** Repeated in metadata so a decoded head cannot be detached from its vault. */
  vaultId: string;
  /** Device which last published this head, when known. */
  deviceId?: string;
  /** Optional producer label for forward-compatible diagnostics. */
  producer?: string;
  /** Immutable source pin recorded by the one-shot v7→v8 migration. */
  migratedFrom?: {
    path: "sync/v7/head.json" | "sync/v8/head.json";
    blobSha: string;
    generation: number;
  };
}

export interface SyncV7SegmentMetadata {
  vaultId: string;
  createdAt: string;
  /** Optional producer/device label; cursor values remain authoritative. */
  deviceId?: string;
  producer?: string;
}

export interface SyncV7SegmentDescriptor extends SyncV7Descriptor {
  /** Replay key. It is intentionally independent of path/hash. */
  generation: number;
  /** Replay tie-breaker within a generation. */
  ordinal: number;
  count: number;
  /** Highest observed local sequence per device in this segment. */
  cursors: Record<string, number>;
  metadata: SyncV7SegmentMetadata;
}

export interface SyncV7DeviceWatermark {
  /** The install watermark this device last reported (its installedCursors). */
  cursors: Record<string, number>;
  /** When that watermark was published; devices silent for too long retire. */
  syncedAt: string;
}

export interface SyncHeadV7 {
  formatVersion: typeof SYNC_V7_FORMAT_VERSION;
  /** Explicit logical vault identity; never infer this from a repository name. */
  vaultId: string;
  generatedAt: string;
  /** Monotonic publication generation (not a replay ordering substitute). */
  generation: number;
  metadata: SyncV7HeadMetadata;
  /** Null is permitted only for an uninitialised vault. */
  checkpoint: SyncV7Descriptor | null;
  segments: SyncV7SegmentDescriptor[];
  cursors: Record<string, number>;
  /** Per-device install watermarks for causally-stable tombstone GC.  Optional
   *  until the first device reports (absent = every device unconfirmed). */
  devices?: Record<string, SyncV7DeviceWatermark>;
}

export type SyncHeadDescriptorV7 = SyncV7Descriptor;
export type SyncV7Head = SyncHeadV7;
export type SyncV7EventSegmentDescriptor = SyncV7SegmentDescriptor;
export type SyncV7HotSegmentDescriptor = SyncV7SegmentDescriptor;
export type SyncV7CheckpointDescriptor = SyncV7Descriptor;
export type SyncV7ObjectDescriptor = SyncV7Descriptor;

/** A reference used inside an event when the payload is too large to inline. */
export interface SyncV7ImmutableRef {
  path: string;
  sha256: string;
  size: number;
  kind: "object" | "asset";
  /** Filled after upload; omitted in an event awaiting publication. */
  blobSha?: string;
}
export type SyncV7BlobRef = SyncV7ImmutableRef;

export interface SyncV7Segment<T = unknown> {
  formatVersion: typeof SYNC_V7_FORMAT_VERSION;
  vaultId: string;
  generation: number;
  ordinal: number;
  metadata: SyncV7SegmentMetadata;
  cursors: Record<string, number>;
  events: T[];
}

export interface SyncV7EncodedSegment<T = unknown> {
  segment: SyncV7Segment<T>;
  bytes: Uint8Array;
  size: number;
  count: number;
}

export interface SyncV7ReplaySegment<T = unknown> {
  generation: number;
  ordinal: number;
  events: readonly T[];
  path?: string;
  metadata?: SyncV7SegmentMetadata;
}

export type SyncV7DescriptorKind = "checkpoint" | "object" | "segment" | "asset" | "history";

export interface SyncV7PublicationFile {
  path: string;
  bytes: SyncV7Bytes;
  kind?: SyncV7DescriptorKind;
  /**
   * The file's bytes are already present on the remote (uploaded out-of-band to
   * obtain its descriptor, e.g. via `uploadedDescriptor`). `publish` must not
   * re-upload it; it only needs to exist when the head is written.
   */
  uploaded?: boolean;
}

export interface SyncV7PublicationPlan {
  objects: SyncV7PublicationFile[];
  segments: SyncV7PublicationFile[];
  /** Present only for initialization or an actual byte-window overflow. */
  checkpoint?: SyncV7PublicationFile;
  head: SyncHeadV7;
  expectedHeadSha?: string;
  order: readonly ["objects", "segments", "head-cas"] | readonly ["checkpoint", "objects", "segments", "head-cas"];
  mode: "append" | "compaction";
}

export interface SyncV7CompactionPlan {
  required: boolean;
  reason: "none" | "initialization" | "hot-window-overflow";
  hotBytes: number;
  /** This is a diagnostic only; it never participates in the decision. */
  segmentCount: number;
  checkpointAllowed: boolean;
}

export interface SyncV7AppendPublicationInput {
  expectedHead: SyncHeadV7;
  head: SyncHeadV7;
  objects?: readonly SyncV7PublicationFile[];
  segments?: readonly SyncV7PublicationFile[];
  expectedHeadSha?: string;
}

