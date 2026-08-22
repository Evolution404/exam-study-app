import { dbV7, enqueueChangeSetV7, listChangeSetsV7 } from "../db/db-v7";
import { rewriteChangeSetMutationsV7, type ChangeSetQueueRecordV7 } from "../db/db-v7-change-sets";
import type { ImageAsset } from "../db/v7-types";
import { IMAGE_EXTENSION_BY_MIME } from "../io/image-assets";
import type { GitHubV7Remote } from "./github-v7-remote";
import { SYNC_V7_ASSET_PREFIX, type SyncV7Descriptor } from "./sync-v7-head";
import { mapWithConcurrency } from "../async/bounded-concurrency";

export const SYNC_V7_ASSET_UPLOAD_CONCURRENCY = 6;

export interface ImageAssetUploadProgress {
  completed: number;
  total: number;
  uploadedBytes: number;
  totalBytes: number;
}

/**
 * Upload local image blobs that have never been published, then fill their
 * remote descriptors into the already-queued import event. Imported assets
 * therefore keep a stable event count throughout sync.
 */
export async function uploadPendingImageAssetsV7(client: GitHubV7Remote, onProgress?: (progress: ImageAssetUploadProgress) => void): Promise<Array<Omit<ImageAsset, "blob">>> {
  const assets = await dbV7.imageAssets.toArray();
  const pendingAssets = assets.filter((asset): asset is ImageAsset & { blob: Blob } => Boolean(asset.blob && !asset.remote));
  if (!pendingAssets.length) return [];
  const totalBytes = pendingAssets.reduce((sum, asset) => sum + asset.size, 0);
  let completed = 0;
  let uploadedBytes = 0;
  onProgress?.({ completed, total: pendingAssets.length, uploadedBytes, totalBytes });
  const pendingBeforeUpload = await listChangeSetsV7(["pending"]);
  // Image-asset events must replay before any question event that references
  // them. The claim order is chronological, so backdate these events just
  // before the oldest pending event instead of enqueueing with `now`.
  const earliest = pendingBeforeUpload.reduce((min, record) => Math.min(min, Date.parse(record.createdAt)), Date.now());
  const createdAt = new Date(earliest - 1).toISOString();
  const publishedAssets = await mapWithConcurrency(pendingAssets, SYNC_V7_ASSET_UPLOAD_CONCURRENCY, async (asset) => {
    const extension = IMAGE_EXTENSION_BY_MIME[asset.mimeType as keyof typeof IMAGE_EXTENSION_BY_MIME];
    if (!extension) throw new Error(`图片 MIME 类型不受支持：${asset.mimeType}`);
    const path = `${SYNC_V7_ASSET_PREFIX}${asset.id}.${extension}`;
    const bytes = new Uint8Array(await asset.blob.arrayBuffer());
    const published = await client.putImmutable({ path, bytes, kind: "asset", sha256: asset.id, size: asset.size });
    const { blob: _blob, ...localDescriptor } = asset;
    void _blob;
    const descriptor: Omit<ImageAsset, "blob"> = { ...localDescriptor, remote: { path, blobSha: published.blobSha, sha256: asset.id, size: asset.size } };
    completed += 1;
    uploadedBytes += asset.size;
    onProgress?.({ completed, total: pendingAssets.length, uploadedBytes, totalBytes });
    return { source: asset, descriptor };
  });

  const descriptorById = new Map<string, Omit<ImageAsset, "blob">>();
  for (const asset of assets) {
    const { blob: _blob, ...descriptor } = asset;
    void _blob;
    descriptorById.set(asset.id, descriptor);
  }
  for (const { descriptor } of publishedAssets) descriptorById.set(descriptor.id, descriptor);

  // Imports already own the image refs in one fixed `question.import` event.
  // Fill remote descriptors into that same pending record instead of creating
  // one new queue event per completed image (which made the badge grow during
  // sync). Legacy import records without `images` are upgraded from the image
  // blocks referenced by their questions.
  const pendingAfterUpload = await listChangeSetsV7(["pending"]);
  const represented = new Set<string>();
  const rewritten: ChangeSetQueueRecordV7[] = [];
  for (const record of pendingAfterUpload) {
    let changed = false;
    const mutations = record.mutations.map((mutation) => {
      if (mutation.kind === "image.asset.save") {
        represented.add(mutation.asset.id);
        const descriptor = descriptorById.get(mutation.asset.id);
        if (!descriptor?.remote || JSON.stringify(descriptor) === JSON.stringify(mutation.asset)) return mutation;
        changed = true;
        return { ...mutation, asset: descriptor };
      }
      if (mutation.kind !== "question.import") return mutation;
      const referenced = new Set(mutation.questions.flatMap((question) => [...question.content, ...question.options.flat()]
        .filter((block) => block.type === "image")
        .map((block) => block.assetId)));
      for (const asset of mutation.images ?? []) referenced.add(asset.id);
      const images = [...referenced]
        .map((id) => descriptorById.get(id) ?? mutation.images?.find((asset) => asset.id === id))
        .filter((asset): asset is Omit<ImageAsset, "blob"> => Boolean(asset))
        .sort((left, right) => left.id.localeCompare(right.id));
      for (const image of images) represented.add(image.id);
      const previous = [...(mutation.images ?? [])].sort((left, right) => left.id.localeCompare(right.id));
      if (JSON.stringify(images) === JSON.stringify(previous)) return mutation;
      changed = true;
      return { ...mutation, ...(images.length ? { images } : {}) };
    });
    if (changed) rewritten.push(await rewriteChangeSetMutationsV7(record, mutations));
  }
  if (rewritten.length) await dbV7.changeSets.bulkPut(rewritten);

  // Manual/legacy image writes that are not part of an import still need an
  // explicit asset event. This fallback is intentionally absent for imported
  // images, whose fixed event has just been rewritten above.
  for (const { descriptor } of publishedAssets) {
    if (!represented.has(descriptor.id)) await enqueueChangeSetV7([{ kind: "image.asset.save", asset: descriptor }], createdAt);
  }
  await dbV7.imageAssets.bulkPut(publishedAssets.map(({ source, descriptor }) => ({ ...source, remote: descriptor.remote })));
  return publishedAssets.map(({ descriptor }) => descriptor);
}

export async function uploadedDescriptor(client: GitHubV7Remote, path: string, bytes: Uint8Array, kind: "checkpoint" | "segment"): Promise<SyncV7Descriptor> {
  const uploaded = await client.putImmutable({ path, bytes, kind });
  // storedSize 让读端在下载前就知道实际传输量（descriptor.size 按设计是解压后字节）。
  return { path: uploaded.path, blobSha: uploaded.blobSha, sha256: uploaded.sha256, size: uploaded.size, storedSize: uploaded.storedSize };
}
