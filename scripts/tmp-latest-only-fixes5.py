from pathlib import Path

ROOT = Path('.')

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')

def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding='utf-8')

# Current persisted round-progress rows only exist after at least one answer.
progress = 'src/lib/practice/progress-scope.ts'
text = read(progress)
text = text.replace('''export interface ScopedAttemptSummary {
  attempts: number;
  correct: number;
  wrong: number;
  giveUps?: number;
  totalElapsedMs?: number;
''', '''export interface ScopedAttemptSummary {
  attempts: number;
  correct: number;
  wrong: number;
  giveUps: number;
  totalElapsedMs: number;
''')
text = text.replace('''function hasRoundProgress(progress: ReviewRoundProgress | undefined): boolean {
  if (!progress) return false;
  return progress.attempts > 0 || progress.correct > 0 || progress.wrong > 0;
}
''', '''function hasRoundProgress(progress: ReviewRoundProgress | undefined): boolean {
  return progress !== undefined;
}
''')
write(progress, text)

# Domain fixtures must model the current complete ReviewRoundProgress shape.
test = 'scripts/tests/test-v7-domain.ts'
text = read(test)
old_helper = '''const roundProgress = (roundId: string, questionId: string, attempts = 1): ReviewRoundProgress => ({
  key: `${roundId}:${questionId}`,
  roundId,
  questionId,
  attempts,
  correct: attempts,
  wrong: 0,
  firstAttemptAt: reference,
  latestAttemptAt: reference,
});
'''
new_helper = '''const roundProgress = (roundId: string, questionId: string, attempts = 1): ReviewRoundProgress => ({
  key: `${roundId}:${questionId}`,
  roundId,
  questionId,
  attempts,
  correct: attempts,
  wrong: 0,
  giveUps: 0,
  totalElapsedMs: attempts * 100,
  firstAttemptAt: reference,
  firstAttemptCorrect: true,
  latestAttemptAt: reference,
  hasBeenWrong: false,
  currentCorrectStreak: attempts,
  correctStreakAfterWrong: 0,
  recentOutcomes: attempts ? [{ id: `${roundId}:${questionId}:attempt`, createdAt: reference, correct: true, elapsedMs: 100 }] : [],
});
'''
if old_helper not in text:
    raise RuntimeError('roundProgress helper not found')
text = text.replace(old_helper, new_helper)
text = text.replace('''assert.equal(isQuestionDoneInScope("round-question", { type: "round", roundId: "round-1" }, [], [roundProgress("round-1", "round-question", 0)], reference), false);
''', '''assert.equal(isQuestionDoneInScope("round-question", { type: "round", roundId: "round-1" }, [], [], reference), false);
''')
text = text.replace('''  calculateProgressCompletion(["round-question", "round-empty"], { type: "round", roundId: "round-1" }, [], [roundProgress("round-1", "round-question"), roundProgress("round-1", "round-empty", 0)], reference),
''', '''  calculateProgressCompletion(["round-question", "round-empty"], { type: "round", roundId: "round-1" }, [], [roundProgress("round-1", "round-question")], reference),
''')
text = text.replace('''  "completion honours round progress with zero attempts",
''', '''  "completion treats a missing current round-progress row as incomplete",
''')
text = text.replace('''assert.equal(summarizeScopedQuestionStats(selectedRoundStats).giveUps, undefined, "unrecoverable round detail stays unknown instead of being fabricated");
''', '''assert.equal(summarizeScopedQuestionStats(selectedRoundStats).giveUps, 0, "current round projection always carries complete detail");
''')
write(test, text)
