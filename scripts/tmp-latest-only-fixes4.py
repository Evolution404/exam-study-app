from pathlib import Path
import re

ROOT = Path('.')

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')

def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding='utf-8')

# 1) Mock backend: retain only current Asset Pack behavior. Remove all runtime
# assertions/fixtures that depend on the retired per-image `remote` descriptor.
mock = 'scripts/tests/test-sync-mock-backend.ts'
text = read(mock)
text = text.replace('import { createGitHubV7Remote } from "../../src/lib/sync/github-v7-remote";\n', '')
text = re.sub(r'^\s*assert\.(?:equal|ok)\([^\n]*\.remote[^\n]*\);\n', '', text, flags=re.M)
text, n = re.subn(
    r'''\n  // Explicit one-shot legacy migration:.*?\n  console\.log\("mock github backend sync \+ current asset-pack contract passed"\);''',
    '\n  console.log("mock github backend sync + current asset-pack contract passed");',
    text,
    count=1,
    flags=re.S,
)
if n == 0:
    # The preceding cleanup may still use the old log message while applying.
    text, n = re.subn(
        r'''\n  // Explicit one-shot legacy migration:.*?\n  console\.log\("mock github backend sync \+ asset-pack migration contract passed"\);''',
        '\n  console.log("mock github backend sync + current asset-pack contract passed");',
        text,
        count=1,
        flags=re.S,
    )
# If cleanup.py already removed this scenario, n==0 is acceptable.
text = text.replace('Per-image remote descriptors\n  // are deliberately absent after publication; the global Asset Index is the\n  // only runtime locator.', 'The global Asset Index is the only runtime locator.')
write(mock, text)

# 2) Current review-round progress is a complete stored shape, not a partially
# populated legacy aggregate.
v7types = 'src/lib/db/v7-types.ts'
text = read(v7types)
old = '''  /** Optional on legacy rows; new/rebuilt rows carry the same evidence as global stats. */
  giveUps?: number;
  totalElapsedMs?: number;
  firstAttemptCorrect?: boolean;
  hasBeenWrong?: boolean;
  currentCorrectStreak?: number;
  correctStreakAfterWrong?: number;
  recentOutcomes?: Array<{ id: string; createdAt: string; correct: boolean; elapsedMs?: number }>;
'''
new = '''  giveUps: number;
  totalElapsedMs: number;
  firstAttemptCorrect: boolean;
  hasBeenWrong: boolean;
  currentCorrectStreak: number;
  correctStreakAfterWrong: number;
  recentOutcomes: Array<{ id: string; createdAt: string; correct: boolean; elapsedMs: number }>;
'''
if old not in text:
    raise RuntimeError('ReviewRoundProgress legacy optional shape not found')
text = text.replace(old, new)
write(v7types, text)

# 3) Review-round writer: optional access now represents only row creation,
# never missing fields on an existing row.
practice = 'src/lib/db/db-v7-practice.ts'
text = read(practice)
pattern = r'''async function progressForAnswerInTx\(roundId: string, questionId: string, attempt: AttemptV7\): Promise<void> \{.*?\n\}\n\n/\*\*\n \* Submit one answer\.'''
replacement = '''async function progressForAnswerInTx(roundId: string, questionId: string, attempt: AttemptV7): Promise<void> {
  const key = `${roundId}:${questionId}`;
  const current = await dbV7.reviewRoundProgress.get(key);
  const recentOutcomes = [...(current ? current.recentOutcomes : []), { id: attempt.id, createdAt: attempt.createdAt, correct: attempt.correct, elapsedMs: Math.max(0, attempt.elapsedMs || 0) }]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .slice(-32);
  let currentCorrectStreak = 0;
  for (let index = recentOutcomes.length - 1; index >= 0 && recentOutcomes[index].correct; index -= 1) currentCorrectStreak += 1;
  const first = !current || attempt.createdAt < current.firstAttemptAt;
  const hasBeenWrong = (current ? current.hasBeenWrong : false) || !attempt.correct;
  const progress: ReviewRoundProgress = {
    key,
    roundId,
    questionId,
    attempts: (current ? current.attempts : 0) + 1,
    correct: (current ? current.correct : 0) + (attempt.correct ? 1 : 0),
    wrong: (current ? current.wrong : 0) + (attempt.correct ? 0 : 1),
    firstAttemptAt: first ? attempt.createdAt : current!.firstAttemptAt,
    latestAttemptAt: current && current.latestAttemptAt > attempt.createdAt ? current.latestAttemptAt : attempt.createdAt,
    giveUps: (current ? current.giveUps : 0) + (attempt.selected ? 0 : 1),
    totalElapsedMs: (current ? current.totalElapsedMs : 0) + Math.max(0, attempt.elapsedMs || 0),
    firstAttemptCorrect: first ? attempt.correct : current!.firstAttemptCorrect,
    hasBeenWrong,
    currentCorrectStreak,
    correctStreakAfterWrong: hasBeenWrong ? currentCorrectStreak : 0,
    recentOutcomes,
  };
  await dbV7.reviewRoundProgress.put(progress);
}

/**
 * Submit one answer.'''
text, n = re.subn(pattern, replacement, text, count=1, flags=re.S)
if n != 1:
    raise RuntimeError('progressForAnswerInTx block not found')
write(practice, text)

# 4) Checkpoint validation requires the complete current statistics shape.
cp = 'src/lib/sync/sync-v7-checkpoint-validation.ts'
text = read(cp)
text = text.replace('''      // 作答时间为可选字段（难度 v2 前的旧 checkpoint 没有）；存在则必须是非负安全整数。
      if (outcome.elapsedMs !== undefined) assertSafeInt(outcome.elapsedMs, `state.attemptStats[${index}].recentOutcomes[${outcomeIndex}].elapsedMs`);
''', '''      assertSafeInt(outcome.elapsedMs, `state.attemptStats[${index}].recentOutcomes[${outcomeIndex}].elapsedMs`);
''')
old_round = '''    ["attempts", "correct", "wrong"].forEach((field) => assertSafeInt(progress[field], `state.reviewRoundProgress[${index}].${field}`));
    assertDate(progress.firstAttemptAt, `state.reviewRoundProgress[${index}].firstAttemptAt`);
    assertDate(progress.latestAttemptAt, `state.reviewRoundProgress[${index}].latestAttemptAt`);
    for (const field of ["giveUps", "totalElapsedMs", "currentCorrectStreak", "correctStreakAfterWrong"] as const) {
      if (progress[field] !== undefined) assertSafeInt(progress[field], `state.reviewRoundProgress[${index}].${field}`);
    }
    for (const field of ["firstAttemptCorrect", "hasBeenWrong"] as const) {
      if (progress[field] !== undefined && typeof progress[field] !== "boolean") fail(`state.reviewRoundProgress[${index}].${field} must be boolean`);
    }
    if (progress.recentOutcomes !== undefined) {
      assertArray(progress.recentOutcomes, `state.reviewRoundProgress[${index}].recentOutcomes`);
      progress.recentOutcomes.forEach((outcome, outcomeIndex) => {
        if (!isRecord(outcome)) fail(`state.reviewRoundProgress[${index}].recentOutcomes[${outcomeIndex}] must be an object`);
        assertString(outcome.id, `state.reviewRoundProgress[${index}].recentOutcomes[${outcomeIndex}].id`);
        if (!attempts.has(outcome.id)) fail(`state.reviewRoundProgress[${index}] references missing attempt ${outcome.id}`);
        assertDate(outcome.createdAt, `state.reviewRoundProgress[${index}].recentOutcomes[${outcomeIndex}].createdAt`);
        if (typeof outcome.correct !== "boolean") fail(`state.reviewRoundProgress[${index}].recentOutcomes[${outcomeIndex}].correct must be boolean`);
        if (outcome.elapsedMs !== undefined) assertSafeInt(outcome.elapsedMs, `state.reviewRoundProgress[${index}].recentOutcomes[${outcomeIndex}].elapsedMs`);
      });
    }
'''
new_round = '''    ["attempts", "correct", "wrong", "giveUps", "totalElapsedMs", "currentCorrectStreak", "correctStreakAfterWrong"].forEach((field) => assertSafeInt(progress[field], `state.reviewRoundProgress[${index}].${field}`));
    assertDate(progress.firstAttemptAt, `state.reviewRoundProgress[${index}].firstAttemptAt`);
    assertDate(progress.latestAttemptAt, `state.reviewRoundProgress[${index}].latestAttemptAt`);
    if (typeof progress.firstAttemptCorrect !== "boolean" || typeof progress.hasBeenWrong !== "boolean") fail(`state.reviewRoundProgress[${index}] boolean fields are invalid`);
    assertArray(progress.recentOutcomes, `state.reviewRoundProgress[${index}].recentOutcomes`);
    progress.recentOutcomes.forEach((outcome, outcomeIndex) => {
      if (!isRecord(outcome)) fail(`state.reviewRoundProgress[${index}].recentOutcomes[${outcomeIndex}] must be an object`);
      assertString(outcome.id, `state.reviewRoundProgress[${index}].recentOutcomes[${outcomeIndex}].id`);
      if (!attempts.has(outcome.id)) fail(`state.reviewRoundProgress[${index}] references missing attempt ${outcome.id}`);
      assertDate(outcome.createdAt, `state.reviewRoundProgress[${index}].recentOutcomes[${outcomeIndex}].createdAt`);
      if (typeof outcome.correct !== "boolean") fail(`state.reviewRoundProgress[${index}].recentOutcomes[${outcomeIndex}].correct must be boolean`);
      assertSafeInt(outcome.elapsedMs, `state.reviewRoundProgress[${index}].recentOutcomes[${outcomeIndex}].elapsedMs`);
    });
'''
if old_round not in text:
    raise RuntimeError('review round optional checkpoint validation block not found')
text = text.replace(old_round, new_round)
write(cp, text)

# 5) Scoped statistics no longer bridge missing historical aggregate fields.
progress = 'src/lib/practice/progress-scope.ts'
text = read(progress)
text = text.replace('''  giveUps?: number;
  totalElapsedMs?: number;
  firstAttemptAt: string;
  firstAttemptCorrect?: boolean;
''', '''  giveUps: number;
  totalElapsedMs: number;
  firstAttemptAt: string;
  firstAttemptCorrect: boolean;
''')
text = text.replace('''  recentOutcomes?: Array<{ id?: string; correct: boolean; createdAt: string; elapsedMs?: number }>;
''', '''  recentOutcomes: Array<{ id: string; correct: boolean; createdAt: string; elapsedMs: number }>;
''')
text = text.replace('''        giveUps: row.giveUps,
        totalElapsedMs: row.totalElapsedMs,
        firstAttemptAt: row.firstAttemptAt,
        firstAttemptCorrect: row.firstAttemptCorrect,
        latestAttemptAt: row.latestAttemptAt,
        hasBeenWrong: row.hasBeenWrong ?? row.wrong > 0,
        currentCorrectStreak: row.currentCorrectStreak ?? (row.wrong === 0 ? row.correct : 0),
        correctStreakAfterWrong: row.correctStreakAfterWrong ?? 0,
        recentOutcomes: row.recentOutcomes,
''', '''        giveUps: row.giveUps,
        totalElapsedMs: row.totalElapsedMs,
        firstAttemptAt: row.firstAttemptAt,
        firstAttemptCorrect: row.firstAttemptCorrect,
        latestAttemptAt: row.latestAttemptAt,
        hasBeenWrong: row.hasBeenWrong,
        currentCorrectStreak: row.currentCorrectStreak,
        correctStreakAfterWrong: row.correctStreakAfterWrong,
        recentOutcomes: row.recentOutcomes,
''')
summary_pattern = r'''export function summarizeScopedQuestionStats\(stats: ReadonlyMap<string, ScopedQuestionStats>\): ScopedAttemptSummary \{.*?\n\}\n\n/\*\*\n \* Bridge a scoped per-question stats row back into the legacy `AttemptStats`'''
summary_replacement = '''export function summarizeScopedQuestionStats(stats: ReadonlyMap<string, ScopedQuestionStats>): ScopedAttemptSummary {
  let attempts = 0;
  let correct = 0;
  let wrong = 0;
  let giveUps = 0;
  let totalElapsedMs = 0;
  let firstCorrect = 0;
  let firstKnown = 0;
  let lastAttemptAt: string | undefined;
  for (const row of stats.values()) {
    attempts += row.total;
    correct += row.correct;
    wrong += row.wrong;
    giveUps += row.giveUps;
    totalElapsedMs += row.totalElapsedMs;
    firstKnown += 1;
    if (row.firstAttemptCorrect) firstCorrect += 1;
    if (!lastAttemptAt || row.latestAttemptAt > lastAttemptAt) lastAttemptAt = row.latestAttemptAt;
  }
  return { attempts, correct, wrong, giveUps, totalElapsedMs, attemptedQuestions: stats.size, firstCorrect, firstKnown, lastAttemptAt };
}

/**
 * Convert scoped per-question statistics into the canonical `AttemptStats`'''
text, n = re.subn(summary_pattern, summary_replacement, text, count=1, flags=re.S)
if n != 1:
    raise RuntimeError('summarizeScopedQuestionStats legacy block not found')
text = text.replace('export function scopedStatsToLegacyAttemptStats(', 'export function scopedStatsToAttemptStats(')
text = text.replace('    giveUps: stats.giveUps ?? 0,', '    giveUps: stats.giveUps,')
text = text.replace('    totalElapsedMs: stats.totalElapsedMs ?? 0,', '    totalElapsedMs: stats.totalElapsedMs,')
text = text.replace('    firstAttemptCorrect: stats.firstAttemptCorrect ?? false,', '    firstAttemptCorrect: stats.firstAttemptCorrect,')
text = re.sub(r'    recentOutcomes: \(stats\.recentOutcomes \?\? \[\]\)\.map\(\(outcome, index\) => \(\{ \.\.\.outcome, id: outcome\.id \?\? `\$\{stats\.questionId\}:\$\{index\}` \}\)\),', '    recentOutcomes: stats.recentOutcomes.map((outcome) => ({ ...outcome })),', text)
write(progress, text)

# Rename the old bridge symbol everywhere it is referenced.
for path in list((ROOT / 'src').rglob('*.ts')) + list((ROOT / 'src').rglob('*.tsx')) + list((ROOT / 'scripts').rglob('*.ts')) + list((ROOT / 'scripts').rglob('*.mjs')):
    source = path.read_text(encoding='utf-8')
    updated = source.replace('scopedStatsToLegacyAttemptStats', 'scopedStatsToAttemptStats')
    if updated != source:
        path.write_text(updated, encoding='utf-8')

# 6) Difficulty evidence is current-format only: elapsedMs is required in the
# model input as it already is in stored AttemptStats/round progress.
metrics = 'src/lib/practice/practice-metrics.ts'
text = read(metrics).replace('  elapsedMs?: number;\n', '  elapsedMs: number;\n')
write(metrics, text)

# Keep negative governance focused on runtime compatibility markers, while
# allowing test descriptions to mention retired formats.
arch = 'scripts/tools/check-architecture.mjs'
text = read(arch)
if 'scopedStatsToLegacyAttemptStats' not in text:
    text += '\nif (/scopedStatsToLegacyAttemptStats/.test(latestOnlySources)) fail("客户端不得恢复旧统计 bridge 命名或兼容入口");\n'
write(arch, text)
