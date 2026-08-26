import type { Attempt, AttemptDailyStats, AttemptStats } from "@/types/types";

export interface AttemptSummary {
  total: number;
  correct: number;
  wrong: number;
  latest: number | null;
  /** Personal mastery risk shown to the user. */
  difficulty: number;
  personalDifficulty: number;
  /** Scheduling score: personal difficulty plus time-since-review risk. */
  reviewPriority: number;
}

export function calculateDifficulty(total: number, wrong: number) {
  return Math.round((wrong + 1) / (total + 2) * 100);
}

// ===== 个人难度 v3：有效时间 + 间隔感知 + 本机校准的掌握度 EMA =====
// 设计（2026-08 用户确认）：
// 1. 「快速做对」相对这道题自己的历史中位作答时间判定（≤0.6× 快 / >1.2× 慢），
//    不用按题型的固定阈值——计算题慢是常态，和自己比才公平。
// 2. 间隔权重按秒级连续对数插值（10 分钟内 0.2 → 12 小时满权重）：刚刷过就
//    再做对多半是瞬时记忆，只给很低权重；隔约半天以上才算完整证据。
// 3. 做错不降权（退步信号恒满学习率）：防瞬时记忆把难度虚高，但不放过退步。
// 4. 速度基线只吸收 1 秒–20 分钟内的正确作答；成熟历史用 walk-forward
//    Brier score 在有界候选中校准学习率，不上传数据、不增加置信度字段。
// 个人难度 = (1 − mastery) × 100，mastery 从 0.5 出发（未作答 = 50）。

export interface DifficultyOutcome {
  correct: boolean;
  createdAt: string;
  elapsedMs: number;
}

export const DIFFICULTY_LEARNING_RATE = 0.35;
const MIN_GAP_FACTOR = 0.2;
const SHORT_GAP_SECONDS = 600;
const LONG_GAP_SECONDS = 43_200;
const FAST_BASELINE_RATIO = 0.6;
const SLOW_BASELINE_RATIO = 1.2;
const QUALITY_FAST = 1;
const QUALITY_NORMAL = 0.75;
const QUALITY_SLOW = 0.45;
const QUALITY_FIRST_CORRECT = 0.9;
const BASELINE_WINDOW = 8;
const BASELINE_MIN_ELAPSED_MS = 1_000;
const BASELINE_MAX_ELAPSED_MS = 20 * 60_000;
const CALIBRATION_MIN_OUTCOMES = 12;
const LEARNING_RATE_CANDIDATES = [0.25, 0.3, DIFFICULTY_LEARNING_RATE, 0.4, 0.45] as const;
const REVIEW_RECENCY_START_MS = 12 * 60 * 60_000;
const REVIEW_RECENCY_FULL_MS = 30 * 24 * 60 * 60_000;

function medianOf(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 距上一作的间隔权重：≤10 分钟 0.2，≥12 小时 1，之间对数插值（30min≈0.41，1h≈0.53，6h≈0.87）。 */
export function attemptGapFactor(gapSeconds: number) {
  if (gapSeconds <= SHORT_GAP_SECONDS) return MIN_GAP_FACTOR;
  if (gapSeconds >= LONG_GAP_SECONDS) return 1;
  return MIN_GAP_FACTOR + (1 - MIN_GAP_FACTOR) * Math.log(gapSeconds / SHORT_GAP_SECONDS) / Math.log(LONG_GAP_SECONDS / SHORT_GAP_SECONDS);
}

function outcomeQuality(outcome: DifficultyOutcome, baselineMs: number | null) {
  if (!outcome.correct) return 0;
  if (baselineMs == null) return QUALITY_FIRST_CORRECT;
  if (!validBaselineElapsed(outcome.elapsedMs)) throw new Error("current difficulty outcomes require elapsedMs");
  if (outcome.elapsedMs <= FAST_BASELINE_RATIO * baselineMs) return QUALITY_FAST;
  if (outcome.elapsedMs <= SLOW_BASELINE_RATIO * baselineMs) return QUALITY_NORMAL;
  return QUALITY_SLOW;
}

function validBaselineElapsed(elapsedMs: number): boolean {
  return elapsedMs !== undefined && Number.isFinite(elapsedMs) && elapsedMs >= BASELINE_MIN_ELAPSED_MS && elapsedMs <= BASELINE_MAX_ELAPSED_MS;
}

function modelDifficultyFromOutcomes(outcomes: readonly DifficultyOutcome[], learningRate: number) {
  const ordered = [...outcomes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let mastery = 0.5;
  let previousAt: number | null = null;
  const baselineTimes: number[] = [];
  for (const outcome of ordered) {
    const createdAt = Date.parse(outcome.createdAt);
    const quality = outcomeQuality(outcome, baselineTimes.length ? medianOf(baselineTimes) : null);
    // 做对才按间隔降权（首次作答无间隔，算完整证据）；做错恒满学习率。
    const gapSeconds = previousAt !== null && Number.isFinite(createdAt)
      ? Math.max(0, (createdAt - previousAt) / 1_000)
      : Number.POSITIVE_INFINITY;
    const factor = outcome.correct ? attemptGapFactor(gapSeconds) : 1;
    mastery += learningRate * factor * (quality - mastery);
    if (Number.isFinite(createdAt)) previousAt = createdAt;
    // 速度基线只吸收有效的正确作答。错误/不会仍影响掌握度，但不会污染
    // 后续“快于自己常态”的判定；过短和超长记录不进入速度基线。
    if (outcome.correct && validBaselineElapsed(outcome.elapsedMs)) {
      baselineTimes.push(outcome.elapsedMs);
      if (baselineTimes.length > BASELINE_WINDOW) baselineTimes.shift();
    }
  }
  return Math.round((1 - mastery) * 100);
}

export interface DifficultyCalibration {
  learningRate: number;
  samples: number;
  brierScore: number | null;
}

/**
 * Locally calibrate the bounded EMA learning rate with walk-forward Brier
 * score. Short histories keep the product default; no telemetry or confidence
 * state is introduced, and an unseen question still starts at 50.
 */
export function calibrateDifficultyLearningRate(outcomes: readonly DifficultyOutcome[]): DifficultyCalibration {
  const ordered = [...outcomes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (ordered.length < CALIBRATION_MIN_OUTCOMES) return { learningRate: DIFFICULTY_LEARNING_RATE, samples: 0, brierScore: null };
  let best = { learningRate: DIFFICULTY_LEARNING_RATE, samples: ordered.length - 1, brierScore: Number.POSITIVE_INFINITY };
  for (const learningRate of LEARNING_RATE_CANDIDATES) {
    let squaredError = 0;
    for (let index = 1; index < ordered.length; index += 1) {
      const predictedCorrect = 1 - modelDifficultyFromOutcomes(ordered.slice(0, index), learningRate) / 100;
      const actual = ordered[index].correct ? 1 : 0;
      squaredError += (predictedCorrect - actual) ** 2;
    }
    const brierScore = squaredError / (ordered.length - 1);
    const improves = brierScore < best.brierScore - Number.EPSILON;
    const equallyGoodButCloserToDefault = Math.abs(brierScore - best.brierScore) <= Number.EPSILON
      && Math.abs(learningRate - DIFFICULTY_LEARNING_RATE) < Math.abs(best.learningRate - DIFFICULTY_LEARNING_RATE);
    if (improves || equallyGoodButCloserToDefault) best = { learningRate, samples: ordered.length - 1, brierScore };
  }
  return best;
}

/** 由作答结果序列（按时间升序处理）估计 0–100 难度。序列为空返回 50。 */
export function difficultyFromOutcomes(outcomes: readonly DifficultyOutcome[]) {
  const calibration = calibrateDifficultyLearningRate(outcomes);
  return modelDifficultyFromOutcomes(outcomes, calibration.learningRate);
}

export function reviewPriorityFromDifficulty(difficulty: number, latest: number | null, referenceTime: number | Date = Date.now()) {
  if (latest === null) return 50;
  const referenceMs = referenceTime instanceof Date ? referenceTime.getTime() : referenceTime;
  const ageMs = Math.max(0, referenceMs - latest);
  const recencyRisk = ageMs <= REVIEW_RECENCY_START_MS ? 0
    : ageMs >= REVIEW_RECENCY_FULL_MS ? 100
      : 100 * Math.log(ageMs / REVIEW_RECENCY_START_MS) / Math.log(REVIEW_RECENCY_FULL_MS / REVIEW_RECENCY_START_MS);
  return Math.round(0.7 * Math.max(0, Math.min(100, difficulty)) + 0.3 * recencyRisk);
}

export function summarizeAttempts(attempts: Attempt[], referenceTime: number | Date = Date.now()): AttemptSummary {
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
  const personalDifficulty = difficultyFromOutcomes(attempts);
  return { total, correct, wrong, latest, difficulty: personalDifficulty, personalDifficulty, reviewPriority: reviewPriorityFromDifficulty(personalDifficulty, latest, referenceTime) };
}

export function createAttemptStats(attempt: Attempt): AttemptStats {
  return {
    questionId: attempt.questionId,
    bankId: attempt.bankId,
    total: 1,
    correct: attempt.correct ? 1 : 0,
    wrong: attempt.correct ? 0 : 1,
    giveUps: attempt.selected ? 0 : 1,
    totalElapsedMs: Math.max(0, attempt.elapsedMs || 0),
    firstAttemptAt: attempt.createdAt,
    firstAttemptCorrect: attempt.correct,
    latestAttemptAt: attempt.createdAt,
    hasBeenWrong: !attempt.correct,
    correctStreakAfterWrong: 0,
    currentCorrectStreak: attempt.correct ? 1 : 0,
    recentOutcomes: [{ id: attempt.id, createdAt: attempt.createdAt, correct: attempt.correct, elapsedMs: Math.max(0, attempt.elapsedMs || 0) }],
  };
}

export function addAttemptToStats(current: AttemptStats | undefined, attempt: Attempt): AttemptStats {
  if (!current) return createAttemptStats(attempt);
  const recentOutcomes = [...current.recentOutcomes, { id: attempt.id, createdAt: attempt.createdAt, correct: attempt.correct, elapsedMs: Math.max(0, attempt.elapsedMs || 0) }]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(-32);
  let currentCorrectStreak = 0;
  for (let index = recentOutcomes.length - 1; index >= 0 && recentOutcomes[index].correct; index -= 1) currentCorrectStreak += 1;
  const isLater = attempt.createdAt >= current.latestAttemptAt;
  const isEarlier = attempt.createdAt < current.firstAttemptAt;
  return {
    ...current,
    bankId: attempt.bankId,
    total: current.total + 1,
    correct: current.correct + (attempt.correct ? 1 : 0),
    wrong: current.wrong + (attempt.correct ? 0 : 1),
    giveUps: current.giveUps + (attempt.selected ? 0 : 1),
    totalElapsedMs: current.totalElapsedMs + Math.max(0, attempt.elapsedMs || 0),
    firstAttemptAt: isEarlier ? attempt.createdAt : current.firstAttemptAt,
    firstAttemptCorrect: isEarlier ? attempt.correct : current.firstAttemptCorrect,
    latestAttemptAt: isLater ? attempt.createdAt : current.latestAttemptAt,
    hasBeenWrong: current.hasBeenWrong || !attempt.correct,
    correctStreakAfterWrong: (current.hasBeenWrong || !attempt.correct) ? currentCorrectStreak : 0,
    currentCorrectStreak,
    recentOutcomes,
  };
}

export function buildAttemptStats(attempts: Attempt[]) {
  let result: AttemptStats | undefined;
  for (const attempt of [...attempts].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    result = addAttemptToStats(result, attempt);
  }
  return result;
}

export function summarizeAttemptStats(stats?: AttemptStats, referenceTime: number | Date = Date.now()): AttemptSummary {
  if (!stats) return { total: 0, correct: 0, wrong: 0, latest: null, difficulty: 50, personalDifficulty: 50, reviewPriority: 50 };
  const latest = new Date(stats.latestAttemptAt).getTime();
  const difficulty = difficultyFromOutcomes(stats.recentOutcomes);
  return {
    total: stats.total,
    correct: stats.correct,
    wrong: stats.wrong,
    latest: Number.isFinite(latest) ? latest : null,
    difficulty,
    personalDifficulty: difficulty,
    reviewPriority: reviewPriorityFromDifficulty(difficulty, Number.isFinite(latest) ? latest : null, referenceTime),
  };
}

export function statsNeedWrongReview(stats: AttemptStats | undefined, requiredCorrectStreak: number) {
  return Boolean(stats?.hasBeenWrong && stats.correctStreakAfterWrong < Math.max(1, requiredCorrectStreak));
}

export function calendarDate(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function attemptDate(attempt: Attempt) {
  return calendarDate(attempt.createdAt);
}

export function attemptDailyKey(attempt: Pick<Attempt, "createdAt" | "questionId">) {
  return `${calendarDate(attempt.createdAt)}:${attempt.questionId}`;
}

export function addAttemptToDailyStats(current: AttemptDailyStats | undefined, attempt: Attempt): AttemptDailyStats {
  return {
    key: attemptDailyKey(attempt),
    date: attemptDate(attempt),
    questionId: attempt.questionId,
    bankId: attempt.bankId,
    total: (current?.total ?? 0) + 1,
    correct: (current?.correct ?? 0) + (attempt.correct ? 1 : 0),
    wrong: (current?.wrong ?? 0) + (attempt.correct ? 0 : 1),
    giveUps: (current?.giveUps ?? 0) + (attempt.selected ? 0 : 1),
    totalElapsedMs: (current?.totalElapsedMs ?? 0) + Math.max(0, attempt.elapsedMs || 0),
  };
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

// ===== 练习记录的活动时间口径（列表排序与卡片时间戳共用）=====
// 已完成按完成时间；进行中/已放弃按最后一道作答题的时间（answer.updatedAt），
// 未作答回退 abandonedAt/startedAt。结构化入参避免组件层与 db 层的类型耦合。

export interface RunActivitySource {
  status: "in_progress" | "completed" | "abandoned";
  startedAt: string;
  completedAt?: string;
  abandonedAt?: string;
  answers: Record<string, { submitted: boolean; updatedAt?: string }>;
}

export function runActivityAt(run: RunActivitySource): string {
  if (run.status === "completed" && run.completedAt) return run.completedAt;
  let latest: string | undefined;
  for (const answer of Object.values(run.answers)) {
    if (answer.submitted && answer.updatedAt && (!latest || answer.updatedAt > latest)) latest = answer.updatedAt;
  }
  return latest ?? run.abandonedAt ?? run.startedAt;
}
