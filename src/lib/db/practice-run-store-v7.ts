import { runActivityAt } from "../practice/practice-metrics";
import { dbV7 } from "./db-v7-core";
import type {
  AttemptV7,
  PracticeRunItemV7,
  PracticeRunRecordV7,
  PracticeRunSourceV7,
  PracticeRunV7,
} from "./v7-types";

export function selectedValuesFromAttemptV7(attempt: AttemptV7): string[] {
  if (attempt.response?.kind === "fill" || attempt.response?.kind === "calculation") return [...attempt.response.values];
  if (attempt.response?.kind === "short") return [attempt.response.text];
  return attempt.selected ? [...attempt.selected] : [];
}

export function attemptHasSelectionV7(attempt: Pick<AttemptV7, "selected" | "response">): boolean {
  if (attempt.response?.kind === "fill" || attempt.response?.kind === "calculation") return attempt.response.values.some((value) => value.length > 0);
  if (attempt.response?.kind === "short") return attempt.response.text.length > 0;
  return attempt.selected.length > 0;
}

export function practiceRunRecordV7(run: PracticeRunV7): PracticeRunRecordV7 {
  const {
    bankId: _bankId,
    bankIds: _bankIds,
    bankName,
    questionIds: _questionIds,
    questionTypes: _questionTypes,
    answers: _answers,
    optionOrders: _optionOrders,
    ...record
  } = run;
  return { ...record, bankNameSnapshot: bankName, activityAt: runActivityAt(run) };
}

export function decomposePracticeRunV7(
  run: PracticeRunV7,
  attempts: readonly AttemptV7[],
): { record: PracticeRunRecordV7; sources: PracticeRunSourceV7[]; items: PracticeRunItemV7[] } {
  const latestAttemptByQuestion = new Map<string, AttemptV7>();
  for (const attempt of attempts) {
    if (attempt.runId !== run.id) continue;
    const current = latestAttemptByQuestion.get(attempt.questionId);
    if (!current || attempt.createdAt > current.createdAt || (attempt.createdAt === current.createdAt && attempt.id > current.id)) {
      latestAttemptByQuestion.set(attempt.questionId, attempt);
    }
  }
  const sources = run.bankIds.map((bankId, position) => ({
    runId: run.id,
    bankId,
    bankNameSnapshot: position === 0 ? run.bankName : bankId,
    position,
  }));
  const items = run.questionIds.map((questionId, position) => {
    const answer = run.answers[questionId];
    const attempt = latestAttemptByQuestion.get(questionId);
    if (answer?.submitted && !attempt) {
      throw new Error(`练习 ${run.id} 的题目 ${questionId} 存在 submitted answer，但没有对应 attempt。`);
    }
    return {
      runId: run.id,
      questionId,
      position,
      questionTypeSnapshot: run.questionTypes[questionId],
      optionOrder: [...(run.optionOrders[questionId] ?? [])],
      ...(attempt ? { submittedAttemptId: attempt.id } : {}),
      ...(!answer?.submitted && answer?.selected?.length ? { draftSelected: [...answer.selected] } : {}),
      ...(!answer?.submitted && answer?.response ? { draftResponse: answer.response } : {}),
    };
  });
  return { record: practiceRunRecordV7(run), sources, items };
}

function answerFromItem(item: PracticeRunItemV7, attempt: AttemptV7 | undefined): PracticeRunV7["answers"][string] | undefined {
  if (item.submittedAttemptId && attempt) {
    return {
      selected: selectedValuesFromAttemptV7(attempt),
      submitted: true,
      correct: attempt.correct,
      updatedAt: attempt.createdAt,
      deviceId: attempt.deviceId,
      eventId: attempt.id,
      ...(attempt.response ? { response: attempt.response } : {}),
      ...(attempt.outcome ? { outcome: attempt.outcome } : {}),
    };
  }
  if (item.draftSelected || item.draftResponse) {
    return {
      selected: [...(item.draftSelected ?? [])],
      submitted: false,
      ...(item.draftResponse ? { response: item.draftResponse } : {}),
    };
  }
  return undefined;
}

export function assemblePracticeRunRecordsV7(
  records: readonly PracticeRunRecordV7[],
  sources: readonly PracticeRunSourceV7[],
  items: readonly PracticeRunItemV7[],
  attempts: readonly AttemptV7[],
): PracticeRunV7[] {
  const attemptsById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const sourcesByRun = new Map<string, PracticeRunSourceV7[]>();
  const itemsByRun = new Map<string, PracticeRunItemV7[]>();
  for (const source of sources) {
    const bucket = sourcesByRun.get(source.runId) ?? [];
    bucket.push(source);
    sourcesByRun.set(source.runId, bucket);
  }
  for (const item of items) {
    const bucket = itemsByRun.get(item.runId) ?? [];
    bucket.push(item);
    itemsByRun.set(item.runId, bucket);
  }
  return records.map((record) => {
    const runSources = (sourcesByRun.get(record.id) ?? []).sort((left, right) => left.position - right.position || left.bankId.localeCompare(right.bankId));
    const runItems = (itemsByRun.get(record.id) ?? []).sort((left, right) => left.position - right.position || left.questionId.localeCompare(right.questionId));
    const answers: PracticeRunV7["answers"] = {};
    const questionTypes: PracticeRunV7["questionTypes"] = {};
    const optionOrders: PracticeRunV7["optionOrders"] = {};
    for (const item of runItems) {
      questionTypes[item.questionId] = item.questionTypeSnapshot;
      if (item.optionOrder.length) optionOrders[item.questionId] = [...item.optionOrder];
      const answer = answerFromItem(item, item.submittedAttemptId ? attemptsById.get(item.submittedAttemptId) : undefined);
      if (answer) answers[item.questionId] = answer;
    }
    const { bankNameSnapshot, activityAt: _activityAt, ...metadata } = record;
    return {
      ...metadata,
      bankId: runSources[0]?.bankId ?? "",
      bankIds: runSources.map((source) => source.bankId),
      bankName: bankNameSnapshot,
      questionIds: runItems.map((item) => item.questionId),
      questionTypes,
      answers,
      optionOrders,
    };
  });
}

export async function hydratePracticeRunRecordsV7(records: readonly PracticeRunRecordV7[]): Promise<PracticeRunV7[]> {
  if (!records.length) return [];
  const runIds = records.map((record) => record.id);
  const [sources, items] = await Promise.all([
    dbV7.practiceRunSources.where("runId").anyOf(runIds).toArray(),
    dbV7.practiceRunItems.where("runId").anyOf(runIds).toArray(),
  ]);
  const attemptIds = [...new Set(items.map((item) => item.submittedAttemptId).filter((id): id is string => Boolean(id)))];
  const attempts = attemptIds.length ? (await dbV7.attempts.bulkGet(attemptIds)).filter((attempt): attempt is AttemptV7 => Boolean(attempt)) : [];
  return assemblePracticeRunRecordsV7(records, sources, items, attempts);
}

export async function getPracticeRunV7(runId: string): Promise<PracticeRunV7 | undefined> {
  const record = await dbV7.practiceRuns.get(runId);
  if (!record) return undefined;
  return (await hydratePracticeRunRecordsV7([record]))[0];
}

export async function bulkGetPracticeRunsV7(runIds: readonly string[]): Promise<Array<PracticeRunV7 | undefined>> {
  if (!runIds.length) return [];
  const records = await dbV7.practiceRuns.bulkGet([...runIds]);
  const existing = records.filter((record): record is PracticeRunRecordV7 => Boolean(record));
  const hydrated = await hydratePracticeRunRecordsV7(existing);
  const byId = new Map(hydrated.map((run) => [run.id, run]));
  return runIds.map((runId) => byId.get(runId));
}

export async function putPracticeRunRecordInTx(run: PracticeRunV7): Promise<void> {
  await dbV7.practiceRuns.put(practiceRunRecordV7(run));
}

export async function deletePracticeRunBundleInTx(runId: string): Promise<void> {
  await Promise.all([
    dbV7.practiceRunSources.where("runId").equals(runId).delete(),
    dbV7.practiceRunItems.where("runId").equals(runId).delete(),
  ]);
  await dbV7.practiceRuns.delete(runId);
}
