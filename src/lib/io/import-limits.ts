/**
 * Central safety limits for user supplied question-bank imports.
 *
 * Keep these values in one place so the XLSX reader, JSON reader and portable
 * bundle reader cannot silently drift apart as the accepted data set grows.
 * All byte limits are logical bytes (MiB = 1024 * 1024).
 */
export interface ImportLimitSet {
  maxBytes: number;
  maxQuestions: number;
  maxOptionsPerQuestion: number;
  maxImagesPerQuestion: number;
}

export interface ImportLimits {
  xlsx: ImportLimitSet & {
    maxArchiveEntries: number;
    maxEntryBytes: number;
    maxTotalUncompressedBytes: number;
  };
  json: Pick<ImportLimitSet, "maxBytes" | "maxQuestions">;
  zip: ImportLimitSet & {
    maxArchiveEntries: number;
    maxEntryBytes: number;
    maxTotalUncompressedBytes: number;
    maxImages: number;
  };
}

const MiB = 1024 * 1024;

/** Stable import contract shared by every supported question-bank format. */
export const IMPORT_LIMITS: Readonly<ImportLimits> = Object.freeze({
  xlsx: Object.freeze({
    maxBytes: 64 * MiB,
    maxArchiveEntries: 16_384,
    maxEntryBytes: 32 * MiB,
    maxTotalUncompressedBytes: 256 * MiB,
    maxQuestions: 50_000,
    maxOptionsPerQuestion: 32,
    maxImagesPerQuestion: 32,
  }),
  json: Object.freeze({
    maxBytes: 64 * MiB,
    maxQuestions: 50_000,
  }),
  zip: Object.freeze({
    maxBytes: 256 * MiB,
    maxArchiveEntries: 16_384,
    maxEntryBytes: 32 * MiB,
    maxTotalUncompressedBytes: 256 * MiB,
    maxQuestions: 50_000,
    maxOptionsPerQuestion: 32,
    maxImagesPerQuestion: 32,
    maxImages: 10_000,
  }),
});

export const IMPORT_MIB = MiB;
