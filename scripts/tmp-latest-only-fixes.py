from pathlib import Path
import re

p = Path('scripts/tests/test-sync-v7-head.ts')
text = p.read_text(encoding='utf-8')
replacements = {
    'return { path: `${prefix}${hash}.json`, blobSha: sha1("a"), sha256: hash, size: bytes(content).byteLength };': 'return { path: `${prefix}${hash}.json`, blobSha: sha1("a"), sha256: hash, size: bytes(content).byteLength, storedSize: bytes(content).byteLength };',
    'sha256: checkpoint.sha256, size: 1, generation: 1': 'sha256: checkpoint.sha256, size: 1, storedSize: 1, generation: 1',
    'sha256: hash, size, generation, ordinal': 'sha256: hash, size, storedSize: size, generation, ordinal',
}
for old, new in replacements.items():
    if old not in text:
        raise RuntimeError(f'test-sync-v7-head fixture not found: {old}')
    text = text.replace(old, new)
p.write_text(text, encoding='utf-8')

p = Path('scripts/tests/test-github-v7-remote.ts')
text = p.read_text(encoding='utf-8')
old = 'checkpoint: { path: checkpointPath, blobSha: sha1("a"), sha256: digest(checkpointBytes), size: checkpointBytes.byteLength },'
new = 'checkpoint: { path: checkpointPath, blobSha: sha1("a"), sha256: digest(checkpointBytes), size: checkpointBytes.byteLength, storedSize: checkpointBytes.byteLength },'
if old not in text:
    raise RuntimeError('test-github-v7-remote checkpoint fixture not found')
p.write_text(text.replace(old, new), encoding='utf-8')

p = Path('scripts/tests/test-sync-v7-checkpoint-extra.ts')
text = p.read_text(encoding='utf-8')
text, n = re.subn(r'''// 3\) 退役的 v6/v7/v8 资产命名空间必须被拒绝，只允许当前 v9 资产路径\n\{.*?\n\}\n\n// 4\) 非法格式与坏 imageAsset 被拒绝\n\{''', '''// 3) 旧单图 remote 元数据已完全退役；当前 checkpoint 出现该字段直接拒绝
{
  const current = await createSyncCheckpointV7();
  const asset = current.state.imageAssets[0] as typeof current.state.imageAssets[number] & { remote?: unknown };
  asset.remote = { path: `sync/v9/assets/${"a".repeat(64)}.webp`, blobSha: "b".repeat(40), sha256: "a".repeat(64), size: 123 };
  assert.throws(() => validateSyncCheckpointV7(current), /retired remote metadata/, "current checkpoint must reject retired per-image remote metadata");
}

// 4) 非法格式与坏 imageAsset 被拒绝
{''', text, count=1, flags=re.S)
if n != 1:
    raise RuntimeError('checkpoint-extra retired asset namespace block not found')
text, n = re.subn(r'''\n  const badAsset = structuredClone\(current\);\n  badAsset\.state\.imageAssets\[0\] = \{.*?\n  assert\.throws\(\(\) => validateSyncCheckpointV7\(badAsset\), /remote\\\.sha256 must equal id/\);\n''', '\n', text, count=1, flags=re.S)
if n != 1:
    raise RuntimeError('checkpoint-extra old remote integrity block not found')
p.write_text(text, encoding='utf-8')
