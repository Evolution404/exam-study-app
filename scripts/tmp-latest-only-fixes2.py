from pathlib import Path

p = Path('scripts/tools/verify-sidestore-release.mjs')
text = p.read_text(encoding='utf-8')
old = '  if (latest.downloadURL !== SIDESTORE_IPA_URL || app.downloadURL !== SIDESTORE_IPA_URL) {\n    throw new Error("更新源没有使用 Cloudflare IPA 代理地址");\n  }\n'
new = '  if (latest.downloadURL !== SIDESTORE_IPA_URL) {\n    throw new Error("更新源没有使用 Cloudflare IPA 代理地址");\n  }\n'
if old not in text:
    raise RuntimeError('SideStore verifier deprecated app.downloadURL check not found')
p.write_text(text.replace(old, new), encoding='utf-8')
