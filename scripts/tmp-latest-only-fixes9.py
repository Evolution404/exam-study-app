from pathlib import Path

path = Path('scripts/tests/test-progress-metrics-boundaries.ts')
text = path.read_text(encoding='utf-8')
old = '''const round = (roundId: string, questionId: string, attempts: number, correct: number, wrong: number): ReviewRoundProgress => ({
  key: `${roundId}:${questionId}`,
  roundId,
  questionId,
  attempts,
  correct,
  wrong,
  firstAttemptAt: T0,
  latestAttemptAt: T0,
});
'''
new = '''const round = (roundId: string, questionId: string, attempts: number, correct: number, wrong: number): ReviewRoundProgress => ({
  key: `${roundId}:${questionId}`,
  roundId,
  questionId,
  attempts,
  correct,
  wrong,
  giveUps: 0,
  totalElapsedMs: attempts * 10,
  firstAttemptAt: T0,
  firstAttemptCorrect: correct > 0,
  latestAttemptAt: T0,
  hasBeenWrong: wrong > 0,
  currentCorrectStreak: wrong > 0 ? 0 : correct,
  correctStreakAfterWrong: 0,
  recentOutcomes: Array.from({ length: attempts }, (_, index) => ({
    id: `${roundId}:${questionId}:${index}`,
    createdAt: T0,
    correct: index < correct,
    elapsedMs: 10,
  })),
});
'''
if old not in text:
    raise RuntimeError('progress-boundary round helper not found')
text = text.replace(old, new)
old_case = '''  assert.equal(isQuestionDoneInScope("q1", { type: "round", roundId: "r1" }, [], [round("r1", "q1", 0, 0, 0)], T0), false, "轮次 0 作答不算完成");
'''
if old_case not in text:
    raise RuntimeError('zero-attempt round compatibility case not found')
text = text.replace(old_case, '''  assert.equal(isQuestionDoneInScope("q1", { type: "round", roundId: "r1" }, [], [], T0), false, "没有轮次进度行时不算完成");
''')
path.write_text(text, encoding='utf-8')
