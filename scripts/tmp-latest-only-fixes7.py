from pathlib import Path
import re

ROOT = Path('.')

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')

def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding='utf-8')

# Reconcile compares and writes only the current local image descriptor fields.
path = 'src/lib/db/db-v7-reconcile.ts'
text = read(path)
text = text.replace('''function canonicalImageDescriptor(asset: {
  id: string; mimeType: string; size: number; width: number; height: number; remote?: unknown;
}): Record<string, unknown> {
  return {
    id: asset.id, mimeType: asset.mimeType, size: asset.size, width: asset.width, height: asset.height,
    ...(asset.remote !== undefined ? { remote: asset.remote } : {}),
  };
}
''', '''function canonicalImageDescriptor(asset: {
  id: string; mimeType: string; size: number; width: number; height: number;
}): Record<string, unknown> {
  return { id: asset.id, mimeType: asset.mimeType, size: asset.size, width: asset.width, height: asset.height };
}
''')
text = text.replace('''            width: asset.width,
            height: asset.height,
            remote: asset.remote,
''', '''            width: asset.width,
            height: asset.height,
''')
write(path, text)

# Full restore likewise updates only current descriptor fields while preserving local blobs.
path = 'src/lib/db/db-v7-restore.ts'
text = read(path).replace('''          width: asset.width,
          height: asset.height,
          remote: asset.remote,
          ...(asset.blob ? { blob: asset.blob } : {}),
''', '''          width: asset.width,
          height: asset.height,
          ...(asset.blob ? { blob: asset.blob } : {}),
''')
write(path, text)

# Queue base must never persist the retired field into syncMeta.
path = 'src/lib/sync/change-set-v7-queue.ts'
text = read(path).replace('''    imageAssets: imageAssets.map((asset) => ({ id: asset.id, mimeType: asset.mimeType, size: asset.size, width: asset.width, height: asset.height, remote: asset.remote })),
''', '''    imageAssets: imageAssets.map((asset) => ({ id: asset.id, mimeType: asset.mimeType, size: asset.size, width: asset.width, height: asset.height })),
''')
write(path, text)

# Checkpoint/projection bridge serializes the exact current descriptor shape.
path = 'src/lib/sync/sync-v7-checkpoint-bridge.ts'
text = read(path)
text = text.replace('''      imageAssets: projection.imageAssets.map((asset) => ({
        id: asset.id,
        mimeType: asset.mimeType,
        size: asset.size,
        width: asset.width,
        height: asset.height,
        remote: asset.remote,
      })),
''', '''      imageAssets: projection.imageAssets.map((asset) => ({
        id: asset.id,
        mimeType: asset.mimeType,
        size: asset.size,
        width: asset.width,
        height: asset.height,
      })),
''')
text = text.replace('''    imageAssets: projection.imageAssets.map((asset) => ({
      id: asset.id,
      mimeType: asset.mimeType,
      size: asset.size,
      width: asset.width,
      height: asset.height,
      remote: asset.remote,
    })),
''', '''    imageAssets: projection.imageAssets.map((asset) => ({
      id: asset.id,
      mimeType: asset.mimeType,
      size: asset.size,
      width: asset.width,
      height: asset.height,
    })),
''')
write(path, text)

# History checkpoint clone uses explicit current image fields, not an object spread
# that could accidentally preserve unknown retired metadata.
path = 'src/lib/sync/sync-v8-history.ts'
text = read(path).replace('''    imageAssets: full.imageAssets.map((item) => ({ ...item, remote: item.remote ? { ...item.remote } : undefined })),
''', '''    imageAssets: full.imageAssets.map((item) => ({ id: item.id, mimeType: item.mimeType, size: item.size, width: item.width, height: item.height })),
''')
write(path, text)

# A current build must contain zero image `remote` field accesses/constructors in
# the DB + Sync implementation. Generic Git remote concepts are not matched.
patterns = [re.compile(r'\.remote\b'), re.compile(r'\bremote\s*:')]
remaining = []
for root in [ROOT / 'src/lib/db', ROOT / 'src/lib/sync']:
    for file in sorted(root.rglob('*')):
        if file.suffix not in {'.ts', '.tsx'}:
            continue
        for lineno, line in enumerate(file.read_text(encoding='utf-8').splitlines(), 1):
            if any(pattern.search(line) for pattern in patterns):
                remaining.append(f'{file}:{lineno}: {line.strip()}')
if remaining:
    raise RuntimeError('retired image remote field remains:\n' + '\n'.join(remaining))
