import { studyDb, enqueueChangeSet, listChangeSets } from "../db/db";
import { rewriteChangeSetMutations, type ChangeSetQueueRecord } from "../db/db-change-sets";
import type { ImageAsset } from "../db/types";
import type { GitHubRemote } from "./github-remote";
import type { SyncDescriptor } from "./sync-head-types";
import { publishImageAssetsAsPacks } from "./image-asset-pack";

/** Bounded image-pack preparation concurrency. */
export const SYNC_ASSET_UPLOAD_CONCURRENCY = 6;

export interface ImageAssetUploadProgress {
  completed: number;
  total: number;
  uploadedBytes: number;
  totalBytes: number;
}

function withoutBlob(asset: ImageAsset): Omit<ImageAsset, "blob"> {
  const { blob: _blob, ...descriptor } = asset;
  void _blob;
  return descriptor;
}

/**
 * Publish every local image missing from the remote Asset Pack index.
 *
 * Sync publishes images only as bounded immutable Asset Packs with a sharded index.
 */
export async function uploadPendingImageAssets(
  client: GitHubRemote,
  onProgress?: (progress: ImageAssetUploadProgress) => void,
): Promise<Array<Omit<ImageAsset, "blob">>> {
  const descriptors = await studyDb.imageAssets.toArray();
  // A brand-new device can enter sync before the remote projection has been installed locally.
  if (!descriptors.length) return [];
  const cachedRows = await studyDb.imageBlobs.bulkGet(descriptors.map((asset) => asset.id));
  const cachedById = new Map(cachedRows.flatMap((row) => row ? [[row.assetId, row.blob] as const] : []));
  const assets: ImageAsset[] = descriptors.map((asset) => {
    const blob = cachedById.get(asset.id);
    return blob ? { ...asset, blob } : asset;
  });

  const pendingBeforeUpload = await listChangeSets(["pending"]);
  const earliest = pendingBeforeUpload.reduce((min, record) => Math.min(min, Date.parse(record.createdAt)), Date.now());
  const createdAt = new Date(earliest - 1).toISOString();

  const published = await publishImageAssetsAsPacks(client, assets, onProgress);
  const descriptorById = new Map<string, Omit<ImageAsset, "blob">>();
  for (const asset of assets) descriptorById.set(asset.id, withoutBlob(asset));
  for (const { descriptor } of published) descriptorById.set(descriptor.id, descriptor);

  // Imports already own image descriptors inside one fixed question.import change-set.
  const pendingAfterUpload = await listChangeSets(["pending"]);
  const represented = new Set<string>();
  const rewritten: ChangeSetQueueRecord[] = [];
  for (const record of pendingAfterUpload) {
    let changed = false;
    const mutations = record.mutations.map((mutation) => {
      if (mutation.kind === "image.asset.save") {
        represented.add(mutation.asset.id);
        const descriptor = descriptorById.get(mutation.asset.id);
        if (!descriptor || JSON.stringify(descriptor) === JSON.stringify(mutation.asset)) return mutation;
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
    if (changed) rewritten.push(await rewriteChangeSetMutations(record, mutations));
  }
  if (rewritten.length) await studyDb.changeSets.bulkPut(rewritten);

  // Only genuinely new manual image writes need a dedicated asset event.
  for (const { descriptor } of published) {
    if (!represented.has(descriptor.id)) await enqueueChangeSet([{ kind: "image.asset.save", asset: descriptor }], createdAt);
  }
  return published.map(({ descriptor }) => descriptor);
}

export async function uploadedDescriptor(client: GitHubRemote, path: string, bytes: Uint8Array, kind: "checkpoint" | "segment"): Promise<SyncDescriptor> {
  const uploaded = await client.putImmutable({ path, bytes, kind });
  // storedSize 让读端在下载前就知道实际传输量（descriptor.size 按设计是解压后字节）。
  return { path: uploaded.path, blobSha: uploaded.blobSha, sha256: uploaded.sha256, size: uploaded.size, storedSize: uploaded.storedSize };
}
