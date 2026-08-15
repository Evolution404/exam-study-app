import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  deleteContentBlock,
  insertImageAtSelection,
  moveContentBlock,
  replaceContentBlock,
} from "../../lib/question-content";
import { performAssetRetry, resolveAssetLoad } from "../../app/asset-image";
import type { ContentBlock } from "../../lib/v6-types";

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");
const assetImage = read("app/asset-image.tsx");
const renderer = read("app/content-block-renderer.tsx");
const editor = read("app/content-block-editor.tsx");
const styles = read("app/styles/content-blocks.css");

// Browser lifecycle and security contracts are source-level assertions because
// this project intentionally has no jsdom/DOM test dependency.
assert.match(assetImage, /URL\.createObjectURL\(blob\)/, "images must be rendered from Blob object URLs");
assert.match(assetImage, /URL\.revokeObjectURL\(createdUrl\)/, "object URLs must be revoked");
assert.doesNotMatch(assetImage, /\bsrc\s*=\s*["'`]https?:\/\//i, "AssetImage must not accept direct HTTP src values");
assert.doesNotMatch(assetImage, /src\s*=\s*\{[^}]*https?:\/\//i, "AssetImage must not construct HTTP src values");
assert.match(assetImage, /resolveAssetLoad\(loaderRef\.current, normalizedAssetId, isOnline\)/, "offline mode must still call the local loader first");
assert.doesNotMatch(assetImage, /if \([^\n]*navigator\.onLine[^\n]*\) \{\s*setState\(\{ status: "offline" \}\);\s*return;/, "offline mode must not short-circuit cached asset lookup");
assert.match(assetImage, /data-state=\{state\.status\}/, "missing/offline/failure state must be exposed");
assert.match(assetImage, /aria-label=\{`重试加载图片/, "asset failures need an accessible retry action");
assert.match(assetImage, /performAssetRetry\(assetId, callback, \(\) => setAttempt/, "retry must reload only after the refresh callback resolves");
assert.doesNotMatch(assetImage, /setAttempt\([\s\S]*?\n\s*try \{[\s\S]*?onRetry/, "retry must not increment the load attempt before onRetry");
assert.doesNotMatch(assetImage, /<figure/, "AssetImage must not add a nested figure around renderer figures");

assert.match(renderer, /<MathText/, "text blocks must use MathText");
assert.match(renderer, /<AssetImage/, "image blocks must use AssetImage");
assert.match(renderer, /figcaption/, "image captions must be rendered");
assert.equal((renderer.match(/<figure/g) ?? []).length, 1, "renderer should own the single figure element for an image caption");

assert.match(editor, /accept="image\/\*"/, "file picker must accept images");
assert.match(editor, /selectionStart/, "text selection start must be recorded");
assert.match(editor, /selectionEnd/, "text selection end must be recorded");
assert.match(editor, /prepareImage\(file\)/, "selected files must go through prepareImage");
assert.match(editor, /insertImageAtSelection/, "insertion must delegate to the pure selection helper");
assert.match(editor, /replaceContentBlock/, "images must support replacement and metadata edits");
assert.match(editor, /deleteContentBlock/, "images must support deletion");
assert.match(editor, /moveContentBlock/, "content blocks must support moving");
assert.match(styles, /content-block-editor-image/, "editor styles must cover image controls");

let loaderCalls = 0;
const cachedOffline = await resolveAssetLoad(async (assetId) => {
  loaderCalls += 1;
  assert.equal(assetId, "asset-offline");
  return new Blob(["cached"], { type: "image/png" });
}, "asset-offline", false);
assert.equal(loaderCalls, 1, "offline cached image must still call loadAsset");
assert.equal(cachedOffline.status, "ready", "a cached Blob remains renderable while offline");
const unavailableOffline = await resolveAssetLoad(async () => undefined, "asset-missing", false);
assert.equal(unavailableOffline.status, "offline", "offline missing assets get an offline state");

const retryEvents: string[] = [];
let releaseRetry!: () => void;
const retryPromise = performAssetRetry("asset-retry", async () => {
  retryEvents.push("refresh-start");
  await new Promise<void>((resolve) => { releaseRetry = resolve; });
  retryEvents.push("refresh-done");
}, () => retryEvents.push("reload"));
await Promise.resolve();
assert.deepEqual(retryEvents, ["refresh-start"], "reload must wait for the async retry callback");
releaseRetry();
await retryPromise;
assert.deepEqual(retryEvents, ["refresh-start", "refresh-done", "reload"], "reload follows completed cache refresh");

const blocks: ContentBlock[] = [
  { id: "text-a", type: "text", text: "前公式$x$后" },
  { id: "text-b", type: "text", text: "尾" },
];
const image: ContentBlock = { id: "image-a", type: "image", assetId: "asset-a", alt: "图", caption: "说明" };
const inserted = insertImageAtSelection(blocks, "text-a", { start: 5, end: 5 }, image);
assert.deepEqual(inserted.map((block) => block.type === "text" ? block.text : block.assetId), ["前公式$x", "asset-a", "$后", "尾"], "caret insertion preserves authored formula text");
const selected = insertImageAtSelection(blocks, "text-a", { start: 1, end: 4 }, { ...image, id: "image-b" });
assert.deepEqual(selected.map((block) => block.type === "text" ? block.text : block.assetId), ["前", "asset-a", "x$后", "尾"], "selection insertion replaces only selected text");
assert.deepEqual(moveContentBlock(inserted, "image-a", 0).map((block) => block.id), ["image-a", "text-a", "text-a:after", "text-b"]);
const replaced = replaceContentBlock(inserted, "image-a", { ...image, id: "image-c", assetId: "asset-c" });
assert.equal(replaced.find((block) => block.type === "image")?.assetId, "asset-c");
assert.deepEqual(deleteContentBlock(replaced, "image-c").map((block) => block.type), ["text", "text", "text"]);

console.log("content block UI tests passed: Blob URL lifecycle, local image source, MathText, selection and block operations");
