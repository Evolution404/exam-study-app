import assert from "node:assert/strict";
import { Directory } from "@capacitor/filesystem";
import { PlatformFileService, encodeExportBytesBase64 } from "../../src/platform/files";

const writes: Array<{ path: string; data: string; directory?: Directory }> = [];
const deletes: Array<{ path: string; directory?: Directory }> = [];
const shares: Array<{ title?: string; files?: string[] }> = [];
const filesystem = {
  writeFile: async (input: { path: string; data: string; directory?: Directory }) => { writes.push(input); return { uri: `file:///cache/${input.path}` }; },
  getUri: async (input: { path: string; directory: Directory }) => ({ uri: `file:///cache/${input.path}` }),
  deleteFile: async (input: { path: string; directory?: Directory }) => { deletes.push(input); },
};
const share = { share: async (input: { title?: string; files?: string[] }) => { shares.push(input); return {}; } };
const native = new PlatformFileService({ environment: { platform: "ios", native: true, ios: true }, filesystem, share });
await native.downloadExport("资料.xlsx", new Uint8Array([0, 255, 16]));
assert.equal(writes.length, 1);
assert.equal(writes[0]?.directory, Directory.Cache, "native exports must use the Cache directory");
assert.equal(writes[0]?.data, encodeExportBytesBase64(new Uint8Array([0, 255, 16])));
assert.equal(shares.length, 1);
assert.deepEqual(shares[0]?.files, [`file:///cache/${writes[0]?.path}`]);
assert.equal(deletes.length, 1, "native exports must clean temporary files after sharing");

const failedDeletes: string[] = [];
const failedFilesystem = {
  writeFile: async (input: { path: string; data: string; directory?: Directory }) => ({ uri: `file:///cache/${input.path}` }),
  getUri: async (input: { path: string; directory: Directory }) => ({ uri: `file:///cache/${input.path}` }),
  deleteFile: async (input: { path: string; directory?: Directory }) => { failedDeletes.push(input.path); },
};
const failed = new PlatformFileService({
  environment: { platform: "ios", native: true, ios: true },
  filesystem: failedFilesystem,
  share: { share: async () => { throw new Error("Share Sheet unavailable"); } },
});
await assert.rejects(() => failed.downloadExport("资料.json", new Uint8Array([1, 2])), /Share Sheet unavailable/);
assert.equal(failedDeletes.length, 1, "failed Share Sheet operations must still clean temporary files");

let clicked = 0;
let revoked = "";
const anchor = { href: "", download: "", hidden: false, click: () => { clicked += 1; }, remove: () => undefined } as unknown as HTMLAnchorElement;
const web = new PlatformFileService({
  environment: { platform: "web", native: false, ios: false },
  window: { matchMedia: () => ({ matches: false }), setTimeout: (callback) => { callback(); return 0; } },
  document: { createElement: () => anchor, body: { appendChild: () => anchor } },
  url: { createObjectURL: () => "blob:test", revokeObjectURL: (url) => { revoked = url; } },
});
await web.downloadExport("资料.zip", new Uint8Array([3, 4]));
assert.equal(clicked, 1, "web exports must retain object-URL download behavior");
assert.equal(revoked, "blob:test");

console.log("native file tests passed: web download and native write/share/cleanup paths");
