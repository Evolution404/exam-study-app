import { Directory, Filesystem, type FilesystemPlugin } from "@capacitor/filesystem";
import { Share, type SharePlugin } from "@capacitor/share";
import type { PlatformEnvironment } from "./environment";
import { getPlatformEnvironment } from "./environment";

export type ExportData = Blob | Uint8Array | ArrayBuffer;

interface FileNavigatorLike {
  share?: (data?: ShareData) => Promise<void>;
  canShare?: (data?: ShareData) => boolean;
}

interface FileWindowLike {
  matchMedia?: (query: string) => { matches: boolean };
  setTimeout?: typeof setTimeout;
}

interface FileDocumentLike {
  createElement(tagName: "a"): HTMLAnchorElement;
  body: { appendChild(node: Node): Node };
}

interface FileUrlLike {
  createObjectURL(object: Blob | MediaSource): string;
  revokeObjectURL(url: string): void;
}

export interface PlatformFileServiceOptions {
  environment?: PlatformEnvironment | (() => PlatformEnvironment);
  filesystem?: Pick<FilesystemPlugin, "writeFile" | "deleteFile" | "getUri">;
  share?: Pick<SharePlugin, "share">;
  navigator?: FileNavigatorLike;
  window?: FileWindowLike;
  document?: FileDocumentLike;
  url?: FileUrlLike;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  json: "application/json",
  zip: "application/zip",
};

function mimeTypeFor(filename: string, explicit?: string): string {
  if (explicit) return explicit;
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

async function bytesFor(data: ExportData): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}

function base64For(bytes: Uint8Array): string {
  // Avoid Buffer here: this module is bundled into WKWebView and must remain
  // browser-native. Chunked btoa also avoids a call-stack-sized spread.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += alphabet[first >> 2];
    output += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    output += second === undefined ? "=" : alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? "=" : alphabet[third & 63];
  }
  return output;
}

function nativeFilePath(filename: string): string {
  const safeName = filename.replace(/[\\/\0]/g, "-").replace(/[^\w.\-\u4e00-\u9fff]/g, "_");
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `exam-study-export-${random}-${safeName}`;
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError";
}

function isShareFallbackError(error: unknown): boolean {
  if (typeof DOMException === "undefined" || !(error instanceof DOMException)) return false;
  return ["NotAllowedError", "SecurityError"].includes(error.name);
}

/**
 * Last-mile export adapter. Encoders stay in pure TypeScript; this class only
 * chooses browser download/share or native Cache-file + Share Sheet delivery.
 */
export class PlatformFileService {
  private readonly options: PlatformFileServiceOptions;

  constructor(options: PlatformFileServiceOptions = {}) {
    this.options = options;
  }

  private environment(): PlatformEnvironment {
    const environment = this.options.environment;
    return typeof environment === "function" ? environment() : environment ?? getPlatformEnvironment();
  }

  private async nativeExport(filename: string, data: ExportData, contentType?: string): Promise<void> {
    const filesystem = this.options.filesystem ?? Filesystem;
    const share = this.options.share ?? Share;
    const path = nativeFilePath(filename);
    try {
      const bytes = await bytesFor(data);
      const result = await filesystem.writeFile({ path, data: base64For(bytes), directory: Directory.Cache });
      const uri = result.uri || (await filesystem.getUri({ path, directory: Directory.Cache })).uri;
      await share.share({ title: filename, files: [uri] });
    } finally {
      try {
        await filesystem.deleteFile({ path, directory: Directory.Cache });
      } catch {
        // Cache cleanup is best effort; a failed cleanup must not hide a
        // successful Share Sheet result (or its original error).
      }
    }
    void contentType;
  }

  private async webExport(filename: string, data: ExportData, contentType?: string): Promise<void> {
    const mimeType = mimeTypeFor(filename, contentType);
    const bytes = data instanceof Blob ? undefined : await bytesFor(data);
    const binary = bytes ? new ArrayBuffer(bytes.byteLength) : undefined;
    if (bytes && binary) new Uint8Array(binary).set(bytes);
    const blob = data instanceof Blob ? data : new Blob([binary as ArrayBuffer], { type: mimeType });
    const file = new File([blob], filename, { type: blob.type || mimeType });
    const browserNavigator = this.options.navigator ?? (typeof navigator !== "undefined" ? navigator : undefined);
    const browserWindow = this.options.window ?? (typeof window !== "undefined" ? window : undefined);
    const browserDocument = this.options.document ?? (typeof document !== "undefined" ? document : undefined);
    const urlApi = this.options.url ?? (typeof URL !== "undefined" ? URL : undefined);
    const mobile = browserWindow?.matchMedia?.("(max-width: 760px)").matches ?? false;
    if (mobile && browserNavigator?.share && (!browserNavigator.canShare || browserNavigator.canShare({ files: [file] }))) {
      try {
        await browserNavigator.share({ title: filename, files: [file] });
        return;
      } catch (error) {
        if (isAbortError(error)) return;
        if (!isShareFallbackError(error)) throw error;
      }
    }
    if (!browserDocument || !urlApi) throw new Error("当前环境不支持文件下载");
    const url = urlApi.createObjectURL(blob);
    const anchor = browserDocument.createElement("a") as HTMLAnchorElement;
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    browserDocument.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    if (browserWindow?.setTimeout) browserWindow.setTimeout(() => urlApi.revokeObjectURL(url), 30_000);
    else if (typeof setTimeout !== "undefined") setTimeout(() => urlApi.revokeObjectURL(url), 30_000);
    else urlApi.revokeObjectURL(url);
  }

  async downloadExport(filename: string, data: ExportData, contentType?: string): Promise<void> {
    if (this.environment().native) return this.nativeExport(filename, data, contentType);
    return this.webExport(filename, data, contentType);
  }
}

export const platformFileService = new PlatformFileService();
export { base64For as encodeExportBytesBase64 };
