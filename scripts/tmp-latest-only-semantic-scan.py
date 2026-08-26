from pathlib import Path
import re

ROOT = Path('.')
pattern = re.compile(r'\b(?:legacy|migrat(?:e|ed|es|ing|ion)|compat(?:ibility|ible)?|fallback|superseded|one-shot|deprecated|retired)\b', re.I)
print('=== semantic compatibility scan (production src only) ===')
count = 0
for path in sorted((ROOT / 'src').rglob('*')):
    if path.suffix not in {'.ts', '.tsx'}:
        continue
    for lineno, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        if pattern.search(line):
            print(f'{path}:{lineno}: {line.strip()}')
            count += 1
print(f'=== semantic matches: {count} ===')
