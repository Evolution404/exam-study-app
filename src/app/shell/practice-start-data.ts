import { readPracticeSetupHistoryForQuestionIds } from "@/lib/db/practice-setup-read";
import { statsNeedWrongReview } from "@/lib/practice/practice-metrics";
import { buildScopedQuestionStats, completedQuestionIdsInScope, normalizeProgressScope, scopedStatsToAttemptStats, type ProgressScope } from "@/lib/practice/progress-scope";
import { TYPE_ORDER, balancedRandomSample, shuffle, summarizeAttemptStats, type PracticeFilter, type PracticePreferences, type Question } from "./helpers";

export async function readPracticeStartData(questionIds: readonly string[], progressScope: ProgressScope, referenceTime: number, wrongRemovalStreak?: number) {
  const history = await readPracticeSetupHistoryForQuestionIds(questionIds, {
    includeAttempts: wrongRemovalStreak !== undefined && progressScope.type !== "round",
  });
  const wrongQuestionIds = new Set<string>();
  if (wrongRemovalStreak !== undefined) {
    for (const [questionId, stats] of buildScopedQuestionStats(questionIds, progressScope, history.attempts, history.roundsProgress, referenceTime)) {
      if (statsNeedWrongReview(scopedStatsToAttemptStats(stats), wrongRemovalStreak)) wrongQuestionIds.add(questionId);
    }
  }
  return {
    attemptMetrics: new Map(history.stats.map((stats) => [stats.questionId, summarizeAttemptStats(stats)])),
    doneQuestionIds: completedQuestionIdsInScope(questionIds, progressScope, history.stats, history.roundsProgress, referenceTime),
    wrongQuestionIds,
  };
}

export async function preparePracticeStartQuestions(inputQuestions: Question[], filter: PracticeFilter, preferences: Pick<PracticePreferences, "progressScope" | "wrongRemovalStreak" | "randomTypeBalance">) {
  let questions = inputQuestions.filter((question) => filter.types.includes(question.type));
  if (filter.tags.length) questions = questions.filter((question) => filter.tagMatch === "all"
    ? filter.tags.every((tag) => question.tags.includes(tag))
    : filter.tags.some((tag) => question.tags.includes(tag)));
  if (filter.keyword.trim()) {
    const keyword = filter.keyword.trim();
    let pattern: RegExp | null = null;
    if (filter.keywordMode === "regex") {
      try { pattern = new RegExp(keyword, "i"); } catch { return { questions: [], error: "正则表达式格式不正确，请检查后重试" }; }
    }
    questions = questions.filter((question) => {
      const searchable = [question.stem, ...question.options, ...question.tags].join("\n");
      return pattern ? pattern.test(searchable) : searchable.toLocaleLowerCase("zh-CN").includes(keyword.toLocaleLowerCase("zh-CN"));
    });
  }
  const progressScope = normalizeProgressScope(filter.progressScope ?? preferences.progressScope);
  const history = await readPracticeStartData(questions.map((question) => question.id), progressScope, Date.now(), filter.status === "wrong" ? preferences.wrongRemovalStreak : undefined);
  const lastAttemptFrom = filter.lastAttemptFrom ? new Date(`${filter.lastAttemptFrom}T00:00:00`).getTime() : null;
  const lastAttemptTo = filter.lastAttemptTo ? new Date(`${filter.lastAttemptTo}T23:59:59.999`).getTime() : null;
  questions = questions.filter((question) => {
    const metric = history.attemptMetrics.get(question.id) ?? summarizeAttemptStats();
    if (filter.status === "unanswered" && history.doneQuestionIds.has(question.id)) return false;
    if (filter.status === "wrong" && !history.wrongQuestionIds.has(question.id)) return false;
    if (filter.status === "favorite" && !question.favorite) return false;
    if (filter.totalAttemptsMin !== null && metric.total < filter.totalAttemptsMin) return false;
    if (filter.totalAttemptsMax !== null && metric.total > filter.totalAttemptsMax) return false;
    if (filter.wrongAttemptsMin !== null && metric.wrong < filter.wrongAttemptsMin) return false;
    if (filter.wrongAttemptsMax !== null && metric.wrong > filter.wrongAttemptsMax) return false;
    if (filter.difficultyMin !== null && metric.difficulty < filter.difficultyMin) return false;
    if (filter.difficultyMax !== null && metric.difficulty > filter.difficultyMax) return false;
    if ((lastAttemptFrom !== null || lastAttemptTo !== null) && metric.latest === null) return false;
    if (lastAttemptFrom !== null && metric.latest !== null && metric.latest < lastAttemptFrom) return false;
    if (lastAttemptTo !== null && metric.latest !== null && metric.latest > lastAttemptTo) return false;
    return true;
  });
  let limitApplied = false;
  if (filter.order === "random") {
    if (filter.limit) {
      questions = preferences.randomTypeBalance === "balanced" ? balancedRandomSample(questions, filter.limit) : shuffle(questions).slice(0, filter.limit);
      limitApplied = true;
    } else questions = shuffle(questions);
  }
  questions = TYPE_ORDER.flatMap((type) => {
    const group = questions.filter((question) => question.type === type);
    if (filter.order === "random") return shuffle(group);
    if (filter.order === "difficulty") return group.sort((a, b) => {
      const left = history.attemptMetrics.get(a.id);
      const right = history.attemptMetrics.get(b.id);
      return (right?.reviewPriority ?? 50) - (left?.reviewPriority ?? 50)
        || (right?.personalDifficulty ?? 50) - (left?.personalDifficulty ?? 50)
        || a.id.localeCompare(b.id);
    });
    return group;
  });
  if (filter.limit && !limitApplied) questions = questions.slice(0, filter.limit);
  return { questions };
}
