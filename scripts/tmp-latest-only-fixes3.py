from pathlib import Path
import re

# Current difficulty evidence always includes elapsedMs and recentOutcomes.
p = Path('src/lib/practice/practice-metrics.ts')
text = p.read_text(encoding='utf-8')
text = text.replace('  elapsedMs?: number;\n', '  elapsedMs: number;\n')
text = text.replace('function validBaselineElapsed(elapsedMs: number | undefined): elapsedMs is number {', 'function validBaselineElapsed(elapsedMs: number): boolean {')
text = text.replace('[...(current.recentOutcomes ?? []),', '[...current.recentOutcomes,')
text = text.replace('// 后续“快于自己常态”的判定；过短和超长旧记录按无计时数据处理。', '// 后续“快于自己常态”的判定；过短和超长记录不进入速度基线。')
p.write_text(text, encoding='utf-8')

# Current checkpoint schema requires elapsedMs in every recent outcome.
p = Path('src/lib/sync/sync-v7-checkpoint-validation.ts')
text = p.read_text(encoding='utf-8')
old = '      // 作答时间为可选字段（难度 v2 前的旧 checkpoint 没有）；存在则必须是非负安全整数。\n      if (outcome.elapsedMs !== undefined) assertSafeInt(outcome.elapsedMs, `state.attemptStats[${index}].recentOutcomes[${outcomeIndex}].elapsedMs`);\n'
new = '      assertSafeInt(outcome.elapsedMs, `state.attemptStats[${index}].recentOutcomes[${outcomeIndex}].elapsedMs`);\n'
if old not in text:
    raise RuntimeError('checkpoint optional elapsedMs compatibility block not found')
p.write_text(text.replace(old, new), encoding='utf-8')

# Remove source-shape assertions that explicitly required old stats compatibility.
p = Path('scripts/tests/test-practice-answer-feedback.ts')
text = p.read_text(encoding='utf-8')
patterns = [
    r'^assert\.match\(metrics, /stats\\\.recentOutcomes.*终身错误率回退.*\n',
    r'^assert\.match\(checkpoint, /outcome\\\.elapsedMs.*新旧互通.*\n',
    r'^assert\.match\(studyApp, /rebuildAttemptStatsFromAttemptsV7.*\n',
]
for pattern in patterns:
    text = re.sub(pattern, '', text, flags=re.M)
insert_after = 'assert.match(metrics, /export function calibrateDifficultyLearningRate/, "成熟本机历史应支持 Brier score 参数校准");\n'
if insert_after not in text:
    raise RuntimeError('practice answer test anchor missing')
text = text.replace(insert_after, insert_after + 'assert.match(metrics, /const difficulty = difficultyFromOutcomes\\(stats\\.recentOutcomes\\)/, "聚合读取只接受当前 outcomes 证据，不得回退旧聚合格式");\n')
checkpoint_anchor = 'const checkpoint = read("src/lib/sync/sync-v7-checkpoint-validation.ts");\n'
if checkpoint_anchor not in text:
    raise RuntimeError('checkpoint test anchor missing')
text = text.replace(checkpoint_anchor, checkpoint_anchor + 'assert.match(checkpoint, /assertSafeInt\\(outcome\\.elapsedMs/, "current checkpoint 必须要求 elapsedMs");\n')
p.write_text(text, encoding='utf-8')

# Site reset only preserves/deletes current storage names; no abandoned v6 DB/config cleanup.
p = Path('src/lib/sync/site-data-reset.ts')
text = p.read_text(encoding='utf-8')
old = 'const CONFIG_LOCAL_STORAGE_KEYS = ["study-v7-preferences", "study-v6-preferences", "github-settings", "github-token", "shijuan-study-v7-device-id", "shijuan-study-v6-device-id"] as const;'
new = 'const CONFIG_LOCAL_STORAGE_KEYS = ["study-v7-preferences", "github-settings", "github-token", "shijuan-study-v7-device-id"] as const;'
if old not in text:
    raise RuntimeError('site reset legacy config list not found')
text = text.replace(old, new)
text = text.replace('  // The reset action is deliberately broader than normal v7 startup: it is\n  // the one user-authorised path that also removes an abandoned legacy DB.\n  const names = new Set([V7_DATABASE_NAME, "memory-line-study", ...databases.map((database) => database.name).filter(Boolean) as string[]]);', '  const names = new Set([V7_DATABASE_NAME, ...databases.map((database) => database.name).filter(Boolean) as string[]]);')
p.write_text(text, encoding='utf-8')
