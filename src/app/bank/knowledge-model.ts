import { summarizeAttemptStats } from "@/lib/practice/practice-metrics";
import type { AttemptStatsV7 } from "@/lib/db/v7-types";

export interface KnowledgeTagQuestion {
  id: string;
  tags: string[];
}

export function buildKnowledgeTagSummaries<T extends KnowledgeTagQuestion>(
  questions: readonly T[],
  attemptStats: readonly AttemptStatsV7[],
  query: string,
) {
  const statsByQuestion = new Map(attemptStats.map((stats) => [stats.questionId, { ...stats, bankId: "" }]));
  const aggregates = new Map<string, { questions: T[]; total: number; correct: number; difficulty: number }>();
  for (const question of questions) {
    const stats = statsByQuestion.get(question.id);
    const difficulty = summarizeAttemptStats(stats).difficulty;
    for (const name of new Set(question.tags)) {
      const current = aggregates.get(name) ?? { questions: [], total: 0, correct: 0, difficulty: 0 };
      current.questions.push(question);
      current.total += stats?.total ?? 0;
      current.correct += stats?.correct ?? 0;
      current.difficulty += difficulty;
      aggregates.set(name, current);
    }
  }
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  return [...aggregates.entries()].map(([name, aggregate]) => ({
    name,
    questions: aggregate.questions,
    count: aggregate.questions.length,
    accuracy: aggregate.total ? Math.round(aggregate.correct / aggregate.total * 100) : 0,
    difficulty: aggregate.questions.length ? Math.round(aggregate.difficulty / aggregate.questions.length) : 50,
  })).filter((item) => item.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery)).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
}
