from pathlib import Path

path = Path('scripts/tests/test-safari-idb-compat.ts')
text = path.read_text(encoding='utf-8')
old = '''const remoteImage = {
  path: `v9/assets/${cachedImageId}`,
  blobSha: "b".repeat(40),
  sha256: cachedImageId,
  size: cachedImageBlob.size,
};
'''
if old not in text:
    raise RuntimeError('Safari remote image fixture not found')
text = text.replace(old, '')
text = text.replace('''  imageAssets: [{ id: cachedImageId, mimeType: "image/png", size: cachedImageBlob.size, width: 20, height: 10, remote: remoteImage }],
''', '''  imageAssets: [{ id: cachedImageId, mimeType: "image/png", size: cachedImageBlob.size, width: 20, height: 10 }],
''')
text = text.replace('''assert.deepEqual(restoredImage?.remote, remoteImage, "descriptor metadata should still advance to the remote version");
''', '''assert.deepEqual(
  { mimeType: restoredImage?.mimeType, size: restoredImage?.size, width: restoredImage?.width, height: restoredImage?.height },
  { mimeType: "image/png", size: cachedImageBlob.size, width: 20, height: 10 },
  "descriptor refresh must retain the current image metadata",
);
''')
path.write_text(text, encoding='utf-8')
