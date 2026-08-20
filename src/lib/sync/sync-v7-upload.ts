import { dbV7, enqueueChangeSetV7, listChangeSetsV7 } from "../db/db-v7";
import type { ImageAsset } from "../db/v7-types";
import { IMAGE_EXTENSION_BY_MIME } from "../io/image-assets";
import type { GitHubV7Remote } from "./github-v7-remote";
import { SYNC_V7_ASSET_PREFIX, type SyncV7Descriptor } from "./sync-v7-head";

/**
 * Upload local image blobs that have never been published, then enqueue
 * image.asset.save events with their v8 remote descriptors. The queue planner
 * orders assets before questions, so a remote device can replay image-bearing
 * questions without missing asset descriptors.
 */
export async function uploadPendingImageAssetsV7(client: GitHubV7Remote): Promise<Array<Omit<ImageAsset, "blob">>> {
  const assets = await dbV7.imageAssets.toArray();
  const uploaded: Array<Omit<ImageAsset, "blob">> = [];
  const pending = await listChangeSetsV7(["pending"]);
  // Image-asset events must replay before any question event that references
  // them. The claim order is chronological, so backdate these events just
  // before the oldest pending event instead of enqueueing with `now`.
  const earliest = pending.reduce((min, record) => Math.min(min, Date.parse(record.createdAt)), Date.now());
  const createdAt = new Date(earliest - 1).toISOString();
  for (const asset of assets) {
    if (!asset.blob || asset.remote) continue;
    const extension = IMAGE_EXTENSION_BY_MIME[asset.mimeType as keyof typeof IMAGE_EXTENSION_BY_MIME];
    if (!extension) throw new Error(`图片 MIME 类型不受支持：${asset.mimeType}`);
    const path = `${SYNC_V7_ASSET_PREFIX}${asset.id}.${extension}`;
    const bytes = new Uint8Array(await asset.blob.arrayBuffer());
    const published = await client.putImmutable({ path, bytes, kind: "asset", sha256: asset.id, size: asset.size });
    const descriptor = { ...asset, blob: undefined, remote: { path, blobSha: published.blobSha, sha256: asset.id, size: asset.size } };
    await enqueueChangeSetV7([{ kind: "image.asset.save", asset: descriptor }], createdAt);
    await dbV7.imageAssets.put({ ...asset, remote: descriptor.remote });
    uploaded.push(descriptor);
  }
  return uploaded;
}

export async function uploadedDescriptor(client: GitHubV7Remote, path: string, bytes: Uint8Array, kind: "checkpoint" | "segment"): Promise<SyncV7Descriptor> {
  const uploaded = await client.putImmutable({ path, bytes, kind });
  // storedSize 让读端在下载前就知道实际传输量（descriptor.size 按设计是解压后字节）。
  return { path: uploaded.path, blobSha: uploaded.blobSha, sha256: uploaded.sha256, size: uploaded.size, storedSize: uploaded.storedSize };
}
