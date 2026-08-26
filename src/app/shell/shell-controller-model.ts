import type { ActivePractice } from "@/types/types";

export type DashboardAggregateRow = {
  total: number;
  correct: number;
  latestAttemptAt?: string;
};

export interface QuickSyncNoticeInput {
  pushed: number;
  pulled: number;
  compacted: boolean;
  remaining: number;
  receivedSnapshot?: {
    questions: number;
    totalAttempts: number;
  } | null;
}

export function mergeSearchHistory(history: readonly string[], keyword: string): string[] {
  const normalized = keyword.trim();
  if (!normalized) return [...history].slice(0, 10);
  return [normalized, ...history.filter((item) => item !== normalized)].slice(0, 10);
}

export function summarizeDashboardRows(
  attemptStats: readonly DashboardAggregateRow[],
  todayRows: readonly DashboardAggregateRow[],
) {
  const totals = attemptStats.reduce(
    (result, row) => ({ attempts: result.attempts + row.total, correct: result.correct + row.correct }),
    { attempts: 0, correct: 0 },
  );
  const todayTotals = todayRows.reduce(
    (result, row) => ({ attempts: result.attempts + row.total, correct: result.correct + row.correct }),
    { attempts: 0, correct: 0 },
  );
  const last = [...attemptStats]
    .filter((row) => row.latestAttemptAt)
    .sort((a, b) => (b.latestAttemptAt ?? "").localeCompare(a.latestAttemptAt ?? ""))[0];
  return {
    attempts: totals.attempts,
    correct: totals.correct,
    todayAttempts: todayTotals.attempts,
    todayCorrect: todayTotals.correct,
    last: last?.latestAttemptAt,
  };
}

export function removeDeletedQuestionFromSession(session: ActivePractice, deletedId: string): ActivePractice {
  if (!session.questionIds.includes(deletedId)) return session;
  const answers = Object.fromEntries(Object.entries(session.answers).filter(([id]) => id !== deletedId));
  const questionTypes = Object.fromEntries(Object.entries(session.questionTypes ?? {}).filter(([id]) => id !== deletedId));
  const questionIds = session.questionIds.filter((id) => id !== deletedId);
  let lastAnsweredIndex = -1;
  questionIds.forEach((id, index) => {
    if (session.answers[id]?.submitted) lastAnsweredIndex = index;
  });
  return {
    ...session,
    questionIds,
    answers,
    questionTypes,
    currentIndex: Math.min(session.currentIndex, Math.max(0, questionIds.length - 1)),
    lastAnsweredIndex,
  };
}

export function formatQuickSyncNotice(result: QuickSyncNoticeInput): string {
  const received = result.receivedSnapshot
    ? `接收 ${result.receivedSnapshot.questions.toLocaleString("zh-CN")} 道题、${result.receivedSnapshot.totalAttempts.toLocaleString("zh-CN")} 条作答`
    : `接收 ${result.pulled} 组操作`;
  return `同步完成：上传 ${result.pushed} 组操作，${received}${result.compacted ? "，远程数据已压缩" : ""}${result.remaining ? `，待同步 ${result.remaining} 组操作` : ""}`;
}
