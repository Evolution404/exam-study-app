from pathlib import Path
import re

ROOT = Path('.')
patterns = [
    ('readBlobWireSize', re.compile(r'\breadBlobWireSize\b')),
    ('normalizeSyncCheckpointV7', re.compile(r'\bnormalizeSyncCheckpointV7\b')),
    ('normalizeStateAliases', re.compile(r'\bnormalizeStateAliases\b')),
    ('bankQuestionMemberships alias', re.compile(r'\bbankQuestionMemberships\b')),
    ('legacyAnswerForSolution', re.compile(r'\blegacyAnswerForSolution\b')),
    ('questionSolution', re.compile(r'\bquestionSolution\s*\(')),
    ('question answer property', re.compile(r'\b(?:question|current|existing|draft|row|item)\.answer\b')),
    ('storedSize optional', re.compile(r'storedSize\s*!==\s*undefined|storedSize\?')),
    ('recent outcome optional elapsed', re.compile(r'elapsedMs\?\s*:\s*number')),
]
print('=== latest-only target scan ===')
for label, pattern in patterns:
    hits = []
    for path in sorted((ROOT / 'src').rglob('*')):
        if path.suffix not in {'.ts', '.tsx'}:
            continue
        for lineno, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
            if pattern.search(line): hits.append(f'{path}:{lineno}: {line.strip()}')
    print(f'--- {label}: {len(hits)} ---')
    for hit in hits: print(hit)
