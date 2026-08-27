interface SafeZipEntry {
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface SafeZipMessages {
  invalidArchive: string;
  tooManyEntries: string;
  directoryCorrupt: string;
  entryTooLarge: string;
  totalTooLarge: string;
  pathTraversal: string;
  emptyPath: string;
  duplicatePath: (path: string) => string;
  missingEntry: (path: string) => string;
  contentIndexCorrupt: string;
  contentIncomplete: string;
  decompressionUnavailable: string;
  expandedEntryTooLarge: string;
  unsupportedCompression: (compression: number) => string;
  lengthMismatch: string;
}

interface SafeZipOptions {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalUncompressedBytes: number;
  fail: (message: string) => never;
  messages: SafeZipMessages;
}

function normalizeArchivePath(value: string, options: SafeZipOptions): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) options.fail(options.messages.pathTraversal);
      parts.pop();
    } else parts.push(part);
  }
  const normalized = parts.join("/");
  if (!normalized) options.fail(options.messages.emptyPath);
  return normalized;
}

function findEndOfCentralDirectory(view: DataView): number {
  const lowerBound = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

function readZipEntries(buffer: ArrayBuffer, options: SafeZipOptions): Map<string, SafeZipEntry> {
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) options.fail(options.messages.invalidArchive);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralDirectoryOffset = view.getUint32(eocd + 16, true);
  if (!entryCount || entryCount > options.maxEntries) options.fail(options.messages.tooManyEntries);
  const decoder = new TextDecoder();
  const entries = new Map<string, SafeZipEntry>();
  let offset = centralDirectoryOffset;
  let totalSize = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== 0x02014b50) options.fail(options.messages.directoryCorrupt);
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    if (uncompressedSize > options.maxEntryBytes) options.fail(options.messages.entryTooLarge);
    totalSize += uncompressedSize;
    if (totalSize > options.maxTotalUncompressedBytes) options.fail(options.messages.totalTooLarge);
    const fileNameEnd = offset + 46 + fileNameLength;
    if (fileNameEnd > view.byteLength) options.fail(options.messages.directoryCorrupt);
    const name = normalizeArchivePath(decoder.decode(new Uint8Array(buffer, offset + 46, fileNameLength)), options);
    if (entries.has(name)) options.fail(options.messages.duplicatePath(name));
    entries.set(name, { compression, compressedSize, uncompressedSize, localHeaderOffset });
    offset = fileNameEnd + extraLength + commentLength;
  }
  return entries;
}

/** Shared, bounds-checked ZIP reader for trusted import parsers. */
export class SafeZipReader {
  private readonly entries: Map<string, SafeZipEntry>;

  constructor(private readonly buffer: ArrayBuffer, private readonly options: SafeZipOptions) {
    this.entries = readZipEntries(buffer, options);
  }

  normalizePath(value: string): string {
    return normalizeArchivePath(value, this.options);
  }

  has(path: string): boolean {
    return this.entries.has(this.normalizePath(path));
  }

  async readBytes(path: string, required = true): Promise<Uint8Array> {
    const normalized = this.normalizePath(path);
    const entry = this.entries.get(normalized);
    if (!entry) {
      if (required) this.options.fail(this.options.messages.missingEntry(path));
      return new Uint8Array(0);
    }
    const view = new DataView(this.buffer);
    const offset = entry.localHeaderOffset;
    if (offset + 30 > view.byteLength || view.getUint32(offset, true) !== 0x04034b50) this.options.fail(this.options.messages.contentIndexCorrupt);
    const fileNameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const dataOffset = offset + 30 + fileNameLength + extraLength;
    if (dataOffset + entry.compressedSize > view.byteLength) this.options.fail(this.options.messages.contentIncomplete);
    const compressed = new Uint8Array(this.buffer, dataOffset, entry.compressedSize);
    let bytes: Uint8Array;
    if (entry.compression === 0) bytes = compressed;
    else if (entry.compression === 8) {
      if (typeof DecompressionStream === "undefined") this.options.fail(this.options.messages.decompressionUnavailable);
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        total += value.byteLength;
        if (total > this.options.maxEntryBytes || total > entry.uncompressedSize) this.options.fail(this.options.messages.expandedEntryTooLarge);
        chunks.push(value);
      }
      bytes = new Uint8Array(total);
      let outputOffset = 0;
      for (const chunk of chunks) { bytes.set(chunk, outputOffset); outputOffset += chunk.byteLength; }
    } else this.options.fail(this.options.messages.unsupportedCompression(entry.compression));
    if (bytes.byteLength !== entry.uncompressedSize) this.options.fail(this.options.messages.lengthMismatch);
    return bytes;
  }

  async readText(path: string, required = true): Promise<string> {
    const normalized = this.normalizePath(path);
    const exists = this.entries.has(normalized);
    const bytes = await this.readBytes(normalized, required);
    if (!bytes.byteLength && !exists) return "";
    return new TextDecoder().decode(bytes);
  }
}
