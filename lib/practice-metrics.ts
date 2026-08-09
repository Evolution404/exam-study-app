import type { Attempt } from "@/lib/types";

export interface AttemptSummary {
  total: number;
  correct: number;
  wrong: number;
  latest: number | null;
  difficulty: number;
}

export function calculateDifficulty(total: number, wrong: number) {
  return Math.round((wrong + 1) / (total + 2) * 100);
}

export function summarizeAttempts(attempts: Attempt[]): AttemptSummary {
  let correct = 0;
  let wrong = 0;
  let latest: number | null = null;
  attempts.forEach((attempt) => {
    if (attempt.correct) correct += 1;
    else wrong += 1;
    const createdAt = new Date(attempt.createdAt).getTime();
    if (Number.isFinite(createdAt) && (latest === null || createdAt > latest)) latest = createdAt;
  });
  const total = correct + wrong;
  return { total, correct, wrong, latest, difficulty: calculateDifficulty(total, wrong) };
}

export function needsWrongReview(attempts: Attempt[], requiredCorrectStreak: number) {
  const ordered = [...attempts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let hasBeenWrong = false;
  let correctStreak = 0;
  ordered.forEach((attempt) => {
    if (attempt.correct) {
      if (hasBeenWrong) correctStreak += 1;
    } else {
      hasBeenWrong = true;
      correctStreak = 0;
    }
  });
  return hasBeenWrong && correctStreak < Math.max(1, requiredCorrectStreak);
}

export function difficultyLabel(score: number) {
  if (score >= 70) return "困难";
  if (score >= 45) return "中等";
  return "容易";
}

export function difficultyTone(score: number): "easy" | "medium" | "hard" {
  if (score >= 70) return "hard";
  if (score >= 45) return "medium";
  return "easy";
}
