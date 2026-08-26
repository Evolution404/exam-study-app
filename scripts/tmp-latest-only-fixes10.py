from pathlib import Path

ROOT = Path('.')

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')

def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding='utf-8')

# 1) Boundary tests: current round/scoped rows always contain their evidence.
path = 'scripts/tests/test-progress-metrics-boundaries.ts'
text = read(path)
text = text.replace('''  // 窗口口径应携带作答序列（含作答时间）供难度 v2 使用；round 口径保持缺省走回退。\n''', '''  // 窗口和轮次口径都携带完整作答证据，供当前个人难度模型使用。\n''')
old = '''  assert.equal(buildScopedQuestionStats(["q1"], { type: "round", roundId: "r1" }, [], [round("r1", "q1", 5, 4, 1)], T0).get("q1")!.recentOutcomes, undefined);\n'''
if old not in text:
    raise RuntimeError('old round-evidence undefined assertion not found')
text = text.replace(old, '''  assert.equal(buildScopedQuestionStats(["q1"], { type: "round", roundId: "r1" }, [], [round("r1", "q1", 5, 4, 1)], T0).get("q1")!.recentOutcomes.length, 5);\n''')
text = text.replace('''  assert.equal(scopedStatsToAttemptStats(stats.get("q1")!).recentOutcomes.length, 3, "legacy 桥接应透传窗口内序列");\n''', '''  assert.equal(scopedStatsToAttemptStats(stats.get("q1")!).recentOutcomes.length, 3, "统计转换应透传窗口内序列");\n''')
old_scoped_fixture = '''  const legacy = scopedStatsToAttemptStats({
    questionId: "q1", total: 3, correct: 1, wrong: 2, giveUps: 1, totalElapsedMs: 30,
    firstAttemptAt: at(-2), firstAttemptCorrect: false, latestAttemptAt: at(0),
    hasBeenWrong: true, currentCorrectStreak: 0, correctStreakAfterWrong: 0,
  });
  assert.equal(legacy.total, 3);
  assert.deepEqual(legacy.recentOutcomes, []);
'''
new_scoped_fixture = '''  const converted = scopedStatsToAttemptStats({
    questionId: "q1", total: 3, correct: 1, wrong: 2, giveUps: 1, totalElapsedMs: 30,
    firstAttemptAt: at(-2), firstAttemptCorrect: false, latestAttemptAt: at(0),
    hasBeenWrong: true, currentCorrectStreak: 0, correctStreakAfterWrong: 0,
    recentOutcomes: [
      { id: "q1:0", createdAt: at(-2), correct: false, elapsedMs: 10 },
      { id: "q1:1", createdAt: at(-1), correct: false, elapsedMs: 10 },
      { id: "q1:2", createdAt: at(0), correct: true, elapsedMs: 10 },
    ],
  });
  assert.equal(converted.total, 3);
  assert.equal(converted.recentOutcomes.length, 3);
'''
if old_scoped_fixture not in text:
    raise RuntimeError('current scoped stats fixture without evidence not found')
text = text.replace(old_scoped_fixture, new_scoped_fixture)
write(path, text)

# 2) The current attempt statistics shape always records elapsedMs in evidence.
for path in ['src/lib/db/v7-types.ts', 'src/types/types.ts']:
    text = read(path)
    text = text.replace('recentOutcomes: Array<{ id: string; createdAt: string; correct: boolean; elapsedMs?: number }>;', 'recentOutcomes: Array<{ id: string; createdAt: string; correct: boolean; elapsedMs: number }>;')
    write(path, text)

# 3) Restore accepts exactly the current wire projection field name.
path = 'src/lib/db/db-v7-core.ts'
text = read(path)
old = '''  /** Wire checkpoints call this `memberships`; the alias eases internal callers. */
  memberships?: BankQuestionMembership[];
  bankQuestionMemberships?: BankQuestionMembership[];
'''
if old not in text:
    raise RuntimeError('restore memberships alias block not found')
text = text.replace(old, '  memberships: BankQuestionMembership[];\n')
text = text.replace('''/**
 * Fresh local namespace for this release train.  It intentionally shares no
 * schema history with `shijuan-study-v7`: content returns through the v9
 * remote restore, and the superseded local database is dropped only after
 * that first successful restore (see the sync layer).
 */
''', '/** Current local IndexedDB namespace. */\n')
text = text.replace('''  // The storage key keeps its historical name so an upgrading device reuses
  // its sync identity instead of appearing as a brand-new collaborator.
''', '  // This is the current durable sync-device identity key.\n')
write(path, text)

# Current-only runtime identifiers must not retain versioned historical names.
for root_name in ['src', 'scripts']:
    for file in (ROOT / root_name).rglob('*'):
        if file.suffix not in {'.ts', '.tsx', '.mjs'}:
            continue
        source = file.read_text(encoding='utf-8')
        updated = source.replace('shijuan-study-v7-device-id', 'shijuan-study-device-id').replace('shijuan-study-v7-sequence', 'shijuan-study-sequence')
        if updated != source:
            file.write_text(updated, encoding='utf-8')

path = 'src/lib/db/db-v7-restore.ts'
text = read(path)
text = text.replace('function restoreRowCount(state: V7RestoreState, memberships: V7RestoreState["memberships"]): number {', 'function restoreRowCount(state: V7RestoreState): number {')
text = text.replace('    memberships ?? [],', '    state.memberships,')
text = text.replace('''  const memberships = state.memberships ?? state.bankQuestionMemberships ?? [];\n''', '')
text = text.replace('const totalRows = Math.max(1, restoreRowCount(state, memberships));', 'const totalRows = Math.max(1, restoreRowCount(state));')
text = text.replace('dbV7.bankQuestionMemberships.bulkPut(memberships)', 'dbV7.bankQuestionMemberships.bulkPut(state.memberships)')
write(path, text)

# 4) Remove stale historical-DB commentary from the public DB barrel; no code path
# is reintroduced by these comments.
path = 'src/lib/db/db-v7.ts'
text = read(path)
text = text.replace(''' * never imports the legacy database (doing so would construct the old
 * Dexie instance) and it does not contain an upgrade or migration path.
''', ' * exposes only the current IndexedDB schema and domain operations.\n')
write(path, text)

path = 'src/lib/db/v7-types.ts'
text = read(path)
text = text.replace(''' * v7 namespace never reads, migrates or falls back to the legacy database.
''', ' * These are the current local-domain records used by the v9 sync wire.\n')
write(path, text)

# 5) Remove stale progress-scope compatibility prose after required-field cutoff.
path = 'src/lib/practice/progress-scope.ts'
text = read(path)
text = text.replace(''' * exact. Named rounds use their durable aggregate projection; fields that
 * cannot be reconstructed after a run is deleted remain explicitly unknown.
''', ''' * exact. Named rounds use their complete durable aggregate projection.
''')
text = text.replace(''' * `recentOutcomes` window for the time-aware personal difficulty. New round
 * projections carry the same evidence; legacy aggregate-only rows still use
 * the count-based fallback.
''', ''' * `recentOutcomes` window for the time-aware personal difficulty. Round
 * projections carry the same evidence.
''')
write(path, text)

# 6) Strict current-only shapes: remove aliases and make required descriptor fields flow end-to-end.
path = 'src/app/bank/bank-library/question-manager.tsx'
text = read(path)
text = text.replace('import type { QuestionV7 } from "@/lib/db/v7-types";', 'import type { QuestionV7, ReviewRoundProgress } from "@/lib/db/v7-types";')
text = text.replace('roundProgress?: Array<{ key: string; roundId: string; questionId: string; attempts: number; correct: number; wrong: number; firstAttemptAt: string; latestAttemptAt: string }>', 'roundProgress?: ReviewRoundProgress[]')
write(path, text)

path = 'src/lib/db/db-v7-reconcile.ts'
text = read(path).replace('const memberships = state.memberships ?? state.bankQuestionMemberships ?? [];', 'const memberships = state.memberships;')
write(path, text)

path = 'src/lib/sync/sync-v7-checkpoint-store.ts'
text = read(path)
text = text.replace('  memberships: (state.memberships ?? state.bankQuestionMemberships ?? []).map((row) => ({ ...row })),', '  memberships: state.memberships.map((row) => ({ ...row })),' )
write(path, text)

path = 'src/lib/sync/image-asset-pack.ts'
text = read(path)
text = text.replace('''  if (record.storedSize !== undefined) {
    assertSafeInteger(record.storedSize, `${label}.storedSize`);
  }
''', '''  assertSafeInteger(record.storedSize, `${label}.storedSize`);
''')
text = text.replace('''    ...(record.storedSize === undefined ? {} : { storedSize: record.storedSize }),
''', '''    storedSize: record.storedSize,
''')
write(path, text)

path = 'src/lib/sync/sync-v7-head-operations.ts'
text = read(path)
text = text.replace('''    ...(value.storedSize === undefined ? {} : { storedSize: value.storedSize }),
''', '''    storedSize: value.storedSize,
''')
write(path, text)

path = 'src/lib/sync/sync-v8-history.ts'
text = read(path)
text = text.replace('''  if (value.storedSize !== undefined) assertSafeInt(value.storedSize, `${label}.storedSize`);
''', '''  assertSafeInt(value.storedSize, `${label}.storedSize`);
''')
write(path, text)

# 7) Remove imports/declarations made obsolete by current-only validation.
path = 'src/lib/sync/sync-v7-checkpoint-validation.ts'
text = read(path).replace('  SHA1,\n', '')
write(path, text)

path = 'scripts/tests/test-persistent-config.ts'
text = read(path).replace('  GITHUB_RELAY_URL,\n', '')
write(path, text)

path = 'scripts/tools/check-architecture.mjs'
text = read(path)
text = text.replace('const syncV7HeadValidation = read("src/lib/sync/sync-v7-head-validation.ts");\n', '')
write(path, text)

# 8) Required ReviewRoundProgress fields no longer need assertions after existence checks.
path = 'src/lib/db/db-v7-practice.ts'
text = read(path)
for old, new in [
    ('current.firstAttemptCorrect as boolean', 'current.firstAttemptCorrect'),
    ('current.hasBeenWrong as boolean', 'current.hasBeenWrong'),
    ('current.currentCorrectStreak as number', 'current.currentCorrectStreak'),
    ('current.correctStreakAfterWrong as number', 'current.correctStreakAfterWrong'),
]:
    text = text.replace(old, new)
write(path, text)
