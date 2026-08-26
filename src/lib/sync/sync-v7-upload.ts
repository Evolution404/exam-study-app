import { dbV7, enqueueChangeSetV7, listChangeSetsV7 } from "../db/db-v7";
import { rewriteChangeSetMutationsV7, type ChangeSetQueueRecordV7 } from "../db/db-v7-change-sets";
import type { ImageAsset } from "../db/v7-types";
import type { GitHubV7Remote } from "./github-v7-remote";
import type { SyncV7Descriptor } from "./sync-v7-head-types";
import { publishImageAssetsAsPacks } from "./image-asset-pack";

/** Legacy public constant retained as the CPU/download hydration lane count. */
export const SYNC_V7_ASSET_UPLOAD_CONCURRENCY = 6;

export interface ImageAssetUploadProgress {
  completed: number;
  total: number;
  uploadedBytes: number;
  totalBytes: number;
}

function withoutBlobOrLegacyRemote(asset: ImageAsset): Omit<ImageAsset, "blob"> {
  const { blob: _blob, remote: _legacyRemote, ...descriptor } = asset;
  void _blob;
  void _legacyRemote;
  return descriptor;
}

/**
 * Publish every local image missing from the remote Asset Pack index.
 *
 * Sync v9 no longer publishes one Git file/commit per image. Images are packed
 * into bounded immutable blobs and the sharded index + mutable index pointer
 * are committed atomically through the Git Data API. The old per-image remote
 * descriptor is stripped after the one-shot migration; runtime reads only the
 * Asset Pack index from that point onward.
 */
export async function uploadPendingImageAssetsV7(
  client: GitHubV7Remote,
  onProgress?: (progress: ImageAssetUploadProgress) => void,
): Promise<Array<Omit<ImageAsset, "blob">>> {
  const assets = await dbV7.imageAssets.toArray();
  // A brand-new device can enter sync before the remote projection has been
  // installed locally. Do not create an empty index in that transient state;
  // the next pass sees the installed image descriptors and performs migration.
  if (!assets.length) return [];

  const pendingBeforeUpload = await listChangeSetsV7(["pending"]);
  const earliest = pendingBeforeUpload.reduce((min, record) => Math.min(min, Date.parse(record.createdAt)), Date.now());
  const createdAt = new Date(earliest - 1).toISOString();

  const published = await publishImageAssetsAsPacks(client, assets, onProgress);
  const descriptorById = new Map<string, Omit<ImageAsset, "blob">>();
  for (const asset of assets) descriptorById.set(asset.id, withoutBlobOrLegacyRemote(asset));
  for (const { descriptor } of published) descriptorById.set(descriptor.id, descriptor);

  // Imports already own image descriptors inside one fixed question.import
  // change-set. Rewrite those descriptors without the retired per-image remote
  // fields; do not create hundreds of image.asset.save events during migration.
  const pendingAfterUpload = await listChangeSetsV7(["pending"]);
  const represented = new Set<string>();
  const rewritten: ChangeSetQueueRecordV7[] = [];
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
    if (changed) rewritten.push(await rewriteChangeSetMutationsV7(record, mutations));
  }
  if (rewritten.length) await dbV7.changeSets.bulkPut(rewritten);

  // Only genuinely new manual image writes need a dedicated asset event. A
  // legacy image already had an event/checkpoint before this one-shot migration,
  // so repacking it must never manufacture a new event per image.
  for (const { source, descriptor } of published) {
    if (!source.remote && !represented.has(descriptor.id)) {
      await enqueueChangeSetV7([{ kind: "image.asset.save", asset: descriptor }], createdAt);
    }
  }

  // The Asset Pack index is now authoritative. Strip every old per-image remote
  // descriptor locally while preserving cached Blob bytes.
  await dbV7.imageAssets.bulkPut(assets.map((asset) => {
    const { remote: _legacyRemote, ...clean } = asset;
    void _legacyRemote;
    return clean;
  }));
  return published.map(({ descriptor }) => descriptor);
}

export async function uploadedDescriptor(client: GitHubV7Remote, path: string, bytes: Uint8Array, kind: "checkpoint" | "segment"): Promise<SyncV7Descriptor> {
  const uploaded = await client.putImmutable({ path, bytes, kind });
  // storedSize 让读端在下载前就知道实际传输量（descriptor.size 按设计是解压后字节）。
  return { path: uploaded.path, blobSha: uploaded.blobSha, sha256: uploaded.sha256, size: uploaded.size, storedSize: uploaded.storedSize };
}
