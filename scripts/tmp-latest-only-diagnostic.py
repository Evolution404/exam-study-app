from pathlib import Path
import re

ROOT = Path('.')
patterns = [re.compile(r'\.remote\b'), re.compile(r'\bremote\s*:')]
roots = [ROOT / 'src/lib/db', ROOT / 'src/lib/sync']
print('=== retired image remote field scan ===')
count = 0
for root in roots:
    for path in sorted(root.rglob('*')):
        if path.suffix not in {'.ts', '.tsx'}:
            continue
        for lineno, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
            if any(pattern.search(line) for pattern in patterns):
                print(f'{path}:{lineno}: {line.strip()}')
                count += 1
print(f'=== matches: {count} ===')
