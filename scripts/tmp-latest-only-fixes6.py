from pathlib import Path
import re

ROOT = Path('.')

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')

def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding='utf-8')

# The DB image table is local descriptor/blob storage only. Remote location is
# exclusively the Asset Pack index in Sync v9.
path = 'src/lib/db/db-v7-images.ts'
text = read(path)
text = text.replace('import { dbV7, nowIso } from "./db-v7-core";\n', 'import { dbV7 } from "./db-v7-core";\n')
text = text.replace('import { enqueueChangeSetV7 } from "./db-v7-change-sets";\n', '')
text, n = re.subn(r'''  if \(asset\.remote\) \{.*?\n  \}\n''', '', text, count=1, flags=re.S)
if n != 1:
    raise RuntimeError('db-v7-images remote validator block not found')
old = '''  const previous = await dbV7.imageAssets.get(asset.id);
  // Re-importing identical local bytes must not discard a descriptor that was
  // already uploaded. Besides causing needless network work, losing `remote`
  // made the pending-event count grow again on the next sync.
  const remoteReusable = Boolean(
    !asset.remote
      && previous?.remote
      && previous.mimeType === asset.mimeType
      && previous.size === asset.size
      && previous.width === asset.width
      && previous.height === asset.height,
  );
  const effective = remoteReusable ? { ...asset, remote: previous!.remote } : asset;
  const descriptorChanged = JSON.stringify({ ...previous, blob: undefined }) !== JSON.stringify({ ...effective, blob: undefined });
  // 保留已缓存的 blob：调用方只写 descriptor 时不应清掉本地图片缓存。
  const stored = effective.blob ?? (previous?.blob?.size === effective.size ? previous.blob : undefined);
  await dbV7.transaction("rw", [dbV7.imageAssets, dbV7.changeSets, dbV7.syncMeta], async () => {
    await dbV7.imageAssets.put(stored ? { ...effective, blob: stored } : effective);
    if (effective.remote && descriptorChanged) {
      const createdAt = nowIso();
      const descriptor = { ...effective, blob: undefined };
      await enqueueChangeSetV7([{ kind: "image.asset.save", asset: descriptor }], createdAt);
    }
  });
  return stored ? { ...effective, blob: stored } : effective;
'''
new = '''  const previous = await dbV7.imageAssets.get(asset.id);
  // Descriptor-only writes preserve an already cached local Blob. Publication
  // state is not persisted per image; Sync v9 resolves it through Asset Pack index.
  const storedBlob = asset.blob ?? (previous?.blob?.size === asset.size ? previous.blob : undefined);
  const stored = storedBlob ? { ...asset, blob: storedBlob } : asset;
  await dbV7.imageAssets.put(stored);
  return stored;
'''
if old not in text:
    raise RuntimeError('db-v7-images remote reuse/write block not found')
text = text.replace(old, new)
write(path, text)

# Hard fail the verifier if any production DB image code reintroduces the
# retired per-image remote descriptor.
final = read(path)
for marker in ['asset.remote', 'previous?.remote', 'remoteReusable', '远端图片 sha256', 'enqueueChangeSetV7']:
    if marker in final:
        raise RuntimeError(f'retired image persistence marker remains: {marker}')

# Ensure the transformed mock no longer constructs or inspects old remote data.
mock = read('scripts/tests/test-sync-mock-backend.ts')
for marker in ['legacy-image-migration', 'remote: {', '?.remote', '!asset.remote', 'createGitHubV7Remote']:
    if marker in mock:
        raise RuntimeError(f'retired sync-mock marker remains after cleanup: {marker}')
