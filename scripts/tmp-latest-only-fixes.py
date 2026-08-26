from pathlib import Path

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
