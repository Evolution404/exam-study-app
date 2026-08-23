import { sha256DigestHex } from "../crypto/sha256";
import { SYNC_V9_ASSET_PREFIX } from "../sync/sync-v7-head";

/**
 * Browser image optimisation and content-addressed asset helpers.
 *
 * The image pipeline deliberately keeps browser primitives behind an adapter.
 * That makes the selection algorithm usable from Node tests and leaves the
 * eventual IndexedDB/Sync integration to callers.
 */

export const IMAGE_MIME_TYPES = ["image/webp", "image/jpeg", "image/png"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export const IMAGE_EXTENSION_BY_MIME: Readonly<Record<ImageMimeType, "webp" | "jpg" | "png">> = Object.freeze({
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
});

export const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, ImageMimeType>> = Object.freeze({
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
});

/** Descriptive aliases kept alongside the canonical allowlist names. */
export const IMAGE_MIME_ALLOWLIST = IMAGE_MIME_TYPES;
export const IMAGE_EXTENSIONS = IMAGE_EXTENSION_BY_MIME;

const DEFAULT_MAX_DIMENSION = 2048;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_INITIAL_QUALITY = 0.86;
const DEFAULT_MIN_QUALITY = 0.3;
const DEFAULT_QUALITY_STEP = 0.12;
const DEFAULT_DIMENSION_SCALE = 0.84;
const DEFAULT_MAX_ATTEMPTS = 96;
/** Keep a malformed adapter from creating an unbounded candidate list. */
const MAX_TOTAL_ATTEMPTS = 300;

/** A fully materialised, optimised image ready for a future asset store. */
export interface OptimizedImageAsset {
  /** SHA-256 of the optimised bytes, represented as lower-case hexadecimal. */
  id: string;
  blob: Blob;
  mimeType: ImageMimeType;
  size: number;
  width: number;
  height: number;
}

export interface ImageOptimizationOptions {
  /** Maximum width or height. Defaults to 2048 pixels. */
  maxDimension?: number;
  /** Maximum encoded byte count. Defaults to 2 MiB. */
  maxBytes?: number;
  /** Try WebP before the JPEG/PNG fallbacks. Defaults to true. */
  preferWebP?: boolean;
  /** Starting quality for lossy encoders. Defaults to 0.86. */
  initialQuality?: number;
  /** Last quality attempted for lossy encoders. Defaults to 0.30. */
  minQuality?: number;
  /** Quality decrement between attempts. Defaults to 0.12. */
  qualityStep?: number;
  /** Dimension decrement after all quality attempts. Defaults to 0.84. */
  dimensionScale?: number;
  /** Safety valve for hostile/buggy encoders. Defaults to 96 attempts per MIME. */
  maxAttempts?: number;
  /** Browser implementation or deterministic test double. */
  adapter?: ImageAssetAdapter;
}

export type OptimizeImageOptions = ImageOptimizationOptions;

/** A decoded image source owned by an ImageAssetAdapter. */
export interface DecodedImage {
  width: number;
  height: number;
  /** True when alpha is known to be present; undefined means unknown. */
  hasAlpha?: boolean;
  /** Native source consumed by the adapter's encoder (ImageBitmap/HTMLImageElement). */
  source?: unknown;
  /** Optional resource-specific close operation. */
  close?: () => void | Promise<void>;
}

export interface EncodeImageOptions {
  mimeType: ImageMimeType;
  width: number;
  height: number;
  /** Omitted for PNG because browser PNG encoders ignore quality. */
  quality?: number;
}

/**
 * Browser capabilities are intentionally injected.  `decode` must honour
 * image orientation and return the oriented dimensions.  `encode` should
 * return null when a MIME encoder is unavailable instead of throwing, although
 * the optimiser also treats a thrown encoder error as an unsupported format.
 */
export interface ImageAssetAdapter {
  decode(input: Blob): Promise<DecodedImage>;
  encode(decoded: DecodedImage, options: EncodeImageOptions): Promise<Blob | null>;
  dispose?(decoded: DecodedImage): void | Promise<void>;
  /** Alias useful for small adapters; dispose takes precedence when present. */
  release?(decoded: DecodedImage): void | Promise<void>;
}

export interface ImageOptimizationAttempt {
  mimeType: ImageMimeType;
  width: number;
  height: number;
  quality?: number;
}

/** Input accepted by the cache occupancy helper. */
export interface CacheStorageEstimate {
  usage?: number;
  quota?: number;
}

export interface CacheOccupancyStats {
  usageBytes: number;
  quotaBytes?: number;
  remainingBytes?: number;
  usageRatio?: number;
  usagePercent?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBlobLike(value: unknown): value is Blob {
  return isRecord(value)
    && typeof value.arrayBuffer === "function"
    && typeof value.size === "number"
    && Number.isFinite(value.size)
    && value.size >= 0;
}

function normalizeMimeType(value: unknown): string {
  if (typeof value !== "string") return "";
  // Blob MIME values are deliberately strict here: parameters such as
  // `;charset=utf-8` are not part of the image allowlist or remote extension
  // mapping.
  return value.trim().toLowerCase();
}

function isImageMimeType(value: string): value is ImageMimeType {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

function assertImageMimeType(value: unknown, field = "MIME 类型"): asserts value is ImageMimeType {
  const mimeType = normalizeMimeType(value);
  if (!isImageMimeType(mimeType)) {
    throw new TypeError(`${field}不受支持，仅允许 WebP、JPEG 或 PNG`);
  }
}

function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError("图片内容地址必须是 64 位小写 SHA-256 十六进制摘要");
  }
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field}必须是正整数`);
  }
}

function assertBoundedQuality(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new TypeError(`${field}必须在 0 和 1 之间`);
  }
}

function assertDimensionScale(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new TypeError("尺寸缩放比例必须大于 0 且小于 1");
  }
}

function toPositiveInteger(value: number): number {
  return Math.max(1, Math.round(value));
}

function dimensionsFor(sourceWidth: number, sourceHeight: number, maxDimension: number): { width: number; height: number } {
  const longest = Math.max(sourceWidth, sourceHeight);
  const scale = Math.min(1, maxDimension / longest);
  return {
    width: toPositiveInteger(sourceWidth * scale),
    height: toPositiveInteger(sourceHeight * scale),
  };
}

function qualityValues(options: Required<Pick<ImageOptimizationOptions, "initialQuality" | "minQuality" | "qualityStep">>): number[] {
  const values: number[] = [];
  for (let quality = options.initialQuality; quality >= options.minQuality - 1e-9; quality -= options.qualityStep) {
    values.push(Number(Math.max(options.minQuality, quality).toFixed(4)));
    if (values.length > 32) break;
  }
  if (values[values.length - 1] !== options.minQuality) values.push(options.minQuality);
  return [...new Set(values)];
}

/**
 * Purely builds the finite sequence of candidate encodes.  Keeping this
 * separate means tests do not need a DOM merely to exercise size/quality
 * selection.
 */
export function buildOptimizationAttempts(
  sourceWidth: number,
  sourceHeight: number,
  options: Pick<ImageOptimizationOptions, "maxDimension" | "initialQuality" | "minQuality" | "qualityStep" | "dimensionScale" | "maxAttempts"> & { mimeTypes?: readonly ImageMimeType[] } = {},
): ImageOptimizationAttempt[] {
  assertPositiveInteger(sourceWidth, "图片宽度");
  assertPositiveInteger(sourceHeight, "图片高度");

  const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  assertPositiveInteger(maxDimension, "最长边");
  const initialQuality = options.initialQuality ?? DEFAULT_INITIAL_QUALITY;
  const minQuality = options.minQuality ?? DEFAULT_MIN_QUALITY;
  const qualityStep = options.qualityStep ?? DEFAULT_QUALITY_STEP;
  const dimensionScale = options.dimensionScale ?? DEFAULT_DIMENSION_SCALE;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  assertBoundedQuality(initialQuality, "初始质量");
  assertBoundedQuality(minQuality, "最低质量");
  if (minQuality > initialQuality) throw new TypeError("最低质量不能高于初始质量");
  assertBoundedQuality(qualityStep, "质量步长");
  assertDimensionScale(dimensionScale);
  assertPositiveInteger(maxAttempts, "最大编码尝试次数");

  const mimeTypes = options.mimeTypes ?? IMAGE_MIME_TYPES;
  if (mimeTypes.length === 0) throw new TypeError("至少需要一种图片编码格式");
  mimeTypes.forEach((mimeType) => assertImageMimeType(mimeType, "编码 MIME 类型"));

  const first = dimensionsFor(sourceWidth, sourceHeight, maxDimension);
  const qualities = qualityValues({ initialQuality, minQuality, qualityStep });
  const attempts: ImageOptimizationAttempt[] = [];
  // Give every candidate format an independent budget.  The total cap keeps
  // a caller-provided MIME list (or unusually large dimensions) bounded while
  // reserving at least one attempt for each format.
  const perMimeBudget = Math.max(1, Math.min(maxAttempts, Math.floor(MAX_TOTAL_ATTEMPTS / mimeTypes.length)));

  // Run the same dimension/quality sequence per requested MIME.  WebP is
  // ordered first by the caller, making the preference explicit and testable.
  for (const mimeType of mimeTypes) {
    let width = first.width;
    let height = first.height;
    let mimeAttempts = 0;
    while (mimeAttempts < perMimeBudget) {
      const mimeQualities = mimeType === "image/png" ? [undefined] : qualities;
      for (const quality of mimeQualities) {
        attempts.push({ mimeType, width, height, ...(quality === undefined ? {} : { quality }) });
        mimeAttempts += 1;
        if (mimeAttempts >= perMimeBudget) break;
      }
      if (width === 1 && height === 1) break;
      const nextWidth = toPositiveInteger(width * dimensionScale);
      const nextHeight = toPositiveInteger(height * dimensionScale);
      if (nextWidth === width && nextHeight === height) break;
      width = nextWidth;
      height = nextHeight;
    }
  }
  return attempts.slice(0, MAX_TOTAL_ATTEMPTS);
}

function candidateMimeTypes(preferWebP: boolean, hasAlpha: boolean | undefined): ImageMimeType[] {
  if (hasAlpha === true) return preferWebP ? ["image/webp", "image/png"] : ["image/png", "image/webp"];
  if (hasAlpha === false) return preferWebP ? ["image/webp", "image/jpeg"] : ["image/jpeg", "image/webp"];
  return preferWebP ? ["image/webp", "image/png", "image/jpeg"] : ["image/png", "image/jpeg", "image/webp"];
}

function assertInputBlob(input: unknown): asserts input is Blob {
  if (!isBlobLike(input)) throw new TypeError("图片输入必须是有效的 Blob 或 File");
  if (input.size === 0) throw new TypeError("图片内容不能为空");
  assertImageMimeType(normalizeMimeType(input.type), "图片 MIME 类型");
}

function normalizeOutputBlob(value: Blob, mimeType: ImageMimeType): Blob {
  if (!isBlobLike(value) || value.size <= 0) throw new Error("图片编码器返回了无效内容");
  // Canvas implementations normally set the type.  Normalising it here also
  // keeps deterministic adapters honest without touching the bytes.
  if (normalizeMimeType(value.type) === mimeType) return value;
  return new Blob([value], { type: mimeType });
}

function normalizeOptions(options: ImageOptimizationOptions): Required<Omit<ImageOptimizationOptions, "adapter">> & { adapter?: ImageAssetAdapter } {
  if (!isRecord(options)) throw new TypeError("图片优化选项无效");
  const source = options as ImageOptimizationOptions;
  const normalized = {
    maxDimension: source.maxDimension ?? DEFAULT_MAX_DIMENSION,
    maxBytes: source.maxBytes ?? DEFAULT_MAX_BYTES,
    preferWebP: source.preferWebP ?? true,
    initialQuality: source.initialQuality ?? DEFAULT_INITIAL_QUALITY,
    minQuality: source.minQuality ?? DEFAULT_MIN_QUALITY,
    qualityStep: source.qualityStep ?? DEFAULT_QUALITY_STEP,
    dimensionScale: source.dimensionScale ?? DEFAULT_DIMENSION_SCALE,
    maxAttempts: source.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    adapter: source.adapter,
  };
  assertPositiveInteger(normalized.maxDimension, "最长边");
  assertPositiveInteger(normalized.maxBytes, "图片大小上限");
  if (typeof normalized.preferWebP !== "boolean") throw new TypeError("preferWebP 必须是布尔值");
  return normalized;
}

function defaultBrowserAdapter(): ImageAssetAdapter {
  const runtime = globalThis as typeof globalThis & {
    createImageBitmap?: (image: Blob, options?: ImageBitmapOptions) => Promise<ImageBitmap>;
  };
  if (typeof document === "undefined") {
    throw new Error("当前环境没有可用的图片解码器，请注入 ImageAssetAdapter");
  }

  const decodeWithBitmap = async (input: Blob): Promise<DecodedImage> => {
    if (typeof runtime.createImageBitmap !== "function") throw new Error("createImageBitmap 不可用");
    const bitmap = await runtime.createImageBitmap(input, { imageOrientation: "from-image" });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  };

  const decodeWithImageElement = async (input: Blob): Promise<DecodedImage> => {
    const urlApi = globalThis.URL;
    if (!urlApi || typeof urlApi.createObjectURL !== "function" || typeof urlApi.revokeObjectURL !== "function") {
      throw new Error("浏览器不支持对象 URL");
    }
    const objectUrl = urlApi.createObjectURL(input);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("图片加载失败"));
        image.src = objectUrl;
      });
      // WebKit may release the decoded backing store as soon as its object URL
      // is revoked. Keep it alive until every canvas encoding attempt finishes.
      return {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => urlApi.revokeObjectURL(objectUrl),
      };
    } catch (error) {
      urlApi.revokeObjectURL(objectUrl);
      throw error;
    }
  };

  return {
    async decode(input) {
      try {
        return await decodeWithBitmap(input);
      } catch {
        try {
          return await decodeWithImageElement(input);
        } catch {
          throw new Error("图片解码失败");
        }
      }
    },
    async encode(decoded, options) {
      const canvas = document.createElement("canvas");
      canvas.width = options.width;
      canvas.height = options.height;
      try {
        const context = canvas.getContext("2d", { alpha: true });
        if (!context) throw new Error("画布不可用");
        context.drawImage(decoded.source as CanvasImageSource, 0, 0, options.width, options.height);
        const blob = await new Promise<Blob | null>((resolve) => {
          // PNG ignores quality; passing undefined is friendlier to browser
          // implementations and deterministic test shims alike.
          canvas.toBlob(resolve, options.mimeType, options.quality);
        });
        return blob;
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    },
    dispose(decoded) {
      if (decoded.close) void decoded.close();
    },
  };
}

/** Optimise a browser File (without retaining or exposing its local path). */
export async function optimizeImageFile(file: File, options: ImageOptimizationOptions = {}): Promise<OptimizedImageAsset> {
  if (!isBlobLike(file)) throw new TypeError("图片文件无效");
  let input: Blob = file;
  if (!normalizeMimeType(file.type)) {
    const name = isRecord(file) && typeof file.name === "string" ? file.name : "";
    const extension = name.toLowerCase().split(".").pop() ?? "";
    const inferred = IMAGE_MIME_BY_EXTENSION[extension];
    if (!inferred) throw new TypeError("无法根据文件名识别图片类型");
    input = new Blob([file], { type: inferred });
  }
  return optimizeImageBlob(input, options);
}

/** Optimise a Blob and return only a newly encoded, size-bounded asset. */
export async function optimizeImageBlob(input: Blob, options: ImageOptimizationOptions = {}): Promise<OptimizedImageAsset> {
  assertInputBlob(input);
  const normalized = normalizeOptions(options);
  const adapter = normalized.adapter ?? defaultBrowserAdapter();
  let decoded: DecodedImage | undefined;
  try {
    try {
      decoded = await adapter.decode(input);
    } catch {
      throw new Error("图片解码失败");
    }
    if (!decoded || !Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height)
      || decoded.width <= 0 || decoded.height <= 0) {
      throw new Error("图片解码尺寸无效");
    }

    const mimeTypes = candidateMimeTypes(normalized.preferWebP, decoded.hasAlpha);
    const attempts = buildOptimizationAttempts(decoded.width, decoded.height, {
      ...normalized,
      mimeTypes,
    });
    let lastEncodeError = false;
    const unavailableMimes = new Set<ImageMimeType>();
    for (const attempt of attempts) {
      if (unavailableMimes.has(attempt.mimeType)) continue;
      let encoded: Blob | null = null;
      try {
        encoded = await adapter.encode(decoded, attempt);
      } catch {
        lastEncodeError = true;
        unavailableMimes.add(attempt.mimeType);
        continue;
      }
      if (!encoded) {
        // Canvas toBlob uses null to signal an unavailable encoder.  Do not
        // waste every quality/dimension attempt on a format that cannot run.
        unavailableMimes.add(attempt.mimeType);
        continue;
      }
      let output: Blob;
      try {
        output = normalizeOutputBlob(encoded, attempt.mimeType);
      } catch {
        lastEncodeError = true;
        unavailableMimes.add(attempt.mimeType);
        continue;
      }
      if (output.size > normalized.maxBytes) continue;
      const id = await sha256Blob(output);
      return {
        id,
        blob: output,
        mimeType: attempt.mimeType,
        size: output.size,
        width: attempt.width,
        height: attempt.height,
      };
    }
    if (lastEncodeError) throw new Error("图片编码失败或当前环境不支持所需格式");
    throw new Error(`图片压缩后仍超过 ${normalized.maxBytes} 字节上限`);
  } finally {
    if (decoded) {
      try {
        if (adapter.dispose) await adapter.dispose(decoded);
        else if (adapter.release) await adapter.release(decoded);
        else if (decoded.close) await decoded.close();
      } catch {
        // Resource cleanup should never replace the useful optimisation error.
      }
    }
  }
}

/** Return a lower-case SHA-256 digest of Blob bytes. */
export async function sha256Blob(blob: Blob): Promise<string> {
  if (!isBlobLike(blob)) throw new TypeError("SHA-256 输入必须是有效的 Blob");
  let bytes: ArrayBuffer;
  try {
    bytes = await blob.arrayBuffer();
  } catch {
    throw new Error("无法读取图片内容");
  }
  try {
    return await sha256DigestHex(new Uint8Array(bytes));
  } catch {
    throw new Error("无法计算图片 SHA-256 摘要");
  }
}

/** Return a lower-case SHA-256 digest of raw bytes. */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  return sha256DigestHex(bytes);
}

/** Strictly map an output MIME to its remote extension. */
export function imageExtensionForMime(mimeType: string): "webp" | "jpg" | "png" {
  const normalized = normalizeMimeType(mimeType);
  assertImageMimeType(normalized);
  return IMAGE_EXTENSION_BY_MIME[normalized];
}

/** Strictly map an extension (with or without a leading dot) to its MIME. */
export function imageMimeForExtension(extension: string): ImageMimeType {
  if (typeof extension !== "string") throw new TypeError("图片扩展名无效");
  const normalized = extension.toLowerCase().replace(/^\./, "");
  const mimeType = IMAGE_MIME_BY_EXTENSION[normalized];
  if (!mimeType) throw new TypeError("图片扩展名不受支持，仅允许 webp、jpg、jpeg 或 png");
  return mimeType;
}

/** Build the immutable v7 content-addressed remote path. */
export function remoteAssetPath(id: string, mimeType: string): string {
  assertDigest(id);
  return `${SYNC_V9_ASSET_PREFIX}${id}.${imageExtensionForMime(mimeType)}`;
}

function normaliseEstimateNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Purely derive cache occupancy fields from a StorageManager estimate. */
export function cacheOccupancyStats(estimate?: CacheStorageEstimate): CacheOccupancyStats;
export function cacheOccupancyStats(usageBytes?: number, quotaBytes?: number): CacheOccupancyStats;
export function cacheOccupancyStats(
  estimateOrUsage: CacheStorageEstimate | number | undefined = undefined,
  quotaArgument?: number,
): CacheOccupancyStats {
  const usage = typeof estimateOrUsage === "number" ? estimateOrUsage : estimateOrUsage?.usage;
  const quota = typeof estimateOrUsage === "number" ? quotaArgument : estimateOrUsage?.quota;
  const usageBytes = normaliseEstimateNumber(usage) ?? 0;
  const quotaBytes = normaliseEstimateNumber(quota);
  if (quotaBytes === undefined || quotaBytes <= 0) return { usageBytes };
  const remainingBytes = Math.max(0, quotaBytes - usageBytes);
  const usageRatio = Math.min(1, usageBytes / quotaBytes);
  return {
    usageBytes,
    quotaBytes,
    remainingBytes,
    usageRatio,
    usagePercent: usageRatio * 100,
  };
}

/** Alias with a verb for callers that prefer a descriptive name. */
export const calculateCacheOccupancy = cacheOccupancyStats;
export const getCacheOccupancyStats = cacheOccupancyStats;
export const cacheUsageStats = cacheOccupancyStats;

export interface StorageEstimateProvider {
  estimate?: () => Promise<CacheStorageEstimate>;
}

/**
 * Ask `navigator.storage.estimate` when available.  Unsupported browsers and
 * rejected estimates intentionally resolve to a zero/unknown result.
 */
export async function estimateCacheOccupancy(storage?: StorageEstimateProvider): Promise<CacheOccupancyStats> {
  const provider = storage ?? (typeof navigator !== "undefined" ? navigator.storage : undefined);
  if (!provider || typeof provider.estimate !== "function") return cacheOccupancyStats(undefined);
  try {
    return cacheOccupancyStats(await provider.estimate());
  } catch {
    return cacheOccupancyStats(undefined);
  }
}

export const getImageCacheStats = estimateCacheOccupancy;

// Keep these constants available to tests and future UI copy without exposing
// implementation details as mutable options.
export const IMAGE_ASSET_DEFAULTS = Object.freeze({
  maxDimension: DEFAULT_MAX_DIMENSION,
  maxBytes: DEFAULT_MAX_BYTES,
  initialQuality: DEFAULT_INITIAL_QUALITY,
  minQuality: DEFAULT_MIN_QUALITY,
  qualityStep: DEFAULT_QUALITY_STEP,
  dimensionScale: DEFAULT_DIMENSION_SCALE,
});
