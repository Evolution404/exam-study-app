import { runActivityAt } from "../practice/practice-metrics";
import { studyDb } from "./db-core";
import type {
  Attempt,
  PracticeRunItem,
  PracticeRunRecord,
  PracticeRunSource,
  PracticeRun,
} from "./types";

export function selectedValuesFromAttempt(attempt: Attempt): string[] {
  if (attempt.response?.kind === "fill" || attempt.response?.kind === "calculation") return [...attempt.response.values];
  if (attempt.response?.kind === "short") return [attempt.response.text];
  return attempt.selected ? [...attempt.selected] : [];
}

export function attemptHasSelection(attempt: Pick<Attempt, "selected" | "response">): boolean {
  if (attempt.response?.kind === "fill" || attempt.response?.kind === "calculation") return attempt.response.values.some((value) => value.length > 0);
  if (attempt.response?.kind === "short") return attempt.response.text.length > 0;
  return attempt.selected.length > 0;
}

export function practiceRunRecord(run: PracticeRun): PracticeRunRecord {
  return {
    id: run.id,
    mode: run.mode,
    modeLabel: run.modeLabel,
    shuffleOptions: run.shuffleOptions,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    status: run.status,
    revision: run.revision,
    bankNameSnapshot: run.bankName,
    activityAt: runActivityAt(run),
    ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
    ...(run.abandonedAt !== undefined ? { abandonedAt: run.abandonedAt } : {}),
    ...(run.lastAnsweredIndex !== undefined ? { lastAnsweredIndex: run.lastAnsweredIndex } : {}),
    ...(run.syncDeviceId !== undefined ? { syncDeviceId: run.syncDeviceId } : {}),
    ...(run.syncEventId !== undefined ? { syncEventId: run.syncEventId } : {}),
    ...(run.definitionSynced !== undefined ? { definitionSynced: run.definitionSynced } : {}),
    ...(run.reviewRoundId !== undefined ? { reviewRoundId: run.reviewRoundId } : {}),
  };
}

export function decomposePracticeRun(
  run: PracticeRun,
  attempts: readonly Attempt[],
): { record: PracticeRunRecord; sources: PracticeRunSource[]; items: PracticeRunItem[] } {
  const latestAttemptByQuestion = new Map<string, Attempt>();
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
  return { record: practiceRunRecord(run), sources, items };
}

/**
 * Decompose many runs without rescanning the complete immutable attempt history
 * once per run. Checkpoint/reconcile paths can contain thousands of attempts;
 * build the run buckets once, then preserve the exact single-run semantics.
 */
export function decomposePracticeRuns(
  runs: readonly PracticeRun[],
  attempts: readonly Attempt[],
): Array<{ record: PracticeRunRecord; sources: PracticeRunSource[]; items: PracticeRunItem[] }> {
  if (!runs.length) return [];
  const attemptsByRun = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const bucket = attemptsByRun.get(attempt.runId);
    if (bucket) bucket.push(attempt);
    else attemptsByRun.set(attempt.runId, [attempt]);
  }
  return runs.map((run) => decomposePracticeRun(run, attemptsByRun.get(run.id) ?? []));
}

function answerFromItem(item: PracticeRunItem, attempt: Attempt | undefined): PracticeRun["answers"][string] | undefined {
  if (item.submittedAttemptId && attempt) {
    return {
      selected: selectedValuesFromAttempt(attempt),
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

export function assemblePracticeRunRecords(
  records: readonly PracticeRunRecord[],
  sources: readonly PracticeRunSource[],
  items: readonly PracticeRunItem[],
  attempts: readonly Attempt[],
): PracticeRun[] {
  const attemptsById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const sourcesByRun = new Map<string, PracticeRunSource[]>();
  const itemsByRun = new Map<string, PracticeRunItem[]>();
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
    const answers: PracticeRun["answers"] = {};
    const questionTypes: PracticeRun["questionTypes"] = {};
    const optionOrders: PracticeRun["optionOrders"] = {};
    for (const item of runItems) {
      questionTypes[item.questionId] = item.questionTypeSnapshot;
      if (item.optionOrder.length) optionOrders[item.questionId] = [...item.optionOrder];
      const answer = answerFromItem(item, item.submittedAttemptId ? attemptsById.get(item.submittedAttemptId) : undefined);
      if (answer) answers[item.questionId] = answer;
    }
    return {
      id: record.id,
      bankId: runSources[0]?.bankId ?? "",
      bankIds: runSources.map((source) => source.bankId),
      bankName: record.bankNameSnapshot,
      mode: record.mode,
      modeLabel: record.modeLabel,
      questionIds: runItems.map((item) => item.questionId),
      questionTypes,
      answers,
      shuffleOptions: record.shuffleOptions,
      optionOrders,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      status: record.status,
      revision: record.revision,
      ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
      ...(record.abandonedAt !== undefined ? { abandonedAt: record.abandonedAt } : {}),
      ...(record.lastAnsweredIndex !== undefined ? { lastAnsweredIndex: record.lastAnsweredIndex } : {}),
      ...(record.syncDeviceId !== undefined ? { syncDeviceId: record.syncDeviceId } : {}),
      ...(record.syncEventId !== undefined ? { syncEventId: record.syncEventId } : {}),
      ...(record.definitionSynced !== undefined ? { definitionSynced: record.definitionSynced } : {}),
      ...(record.reviewRoundId !== undefined ? { reviewRoundId: record.reviewRoundId } : {}),
    };
  });
}

export async function hydratePracticeRunRecords(records: readonly PracticeRunRecord[]): Promise<PracticeRun[]> {
  if (!records.length) return [];
  const runIds = records.map((record) => record.id);
  const [sources, items] = await Promise.all([
    studyDb.practiceRunSources.where("runId").anyOf(runIds).toArray(),
    studyDb.practiceRunItems.where("runId").anyOf(runIds).toArray(),
  ]);
  const attemptIds = [...new Set(items.map((item) => item.submittedAttemptId).filter((id): id is string => Boolean(id)))];
  const attempts = attemptIds.length ? (await studyDb.attempts.bulkGet(attemptIds)).filter((attempt): attempt is Attempt => Boolean(attempt)) : [];
  return assemblePracticeRunRecords(records, sources, items, attempts);
}

export async function getPracticeRun(runId: string): Promise<PracticeRun | undefined> {
  const record = await studyDb.practiceRuns.get(runId);
  if (!record) return undefined;
  return (await hydratePracticeRunRecords([record]))[0];
}

export async function bulkGetPracticeRuns(runIds: readonly string[]): Promise<Array<PracticeRun | undefined>> {
  if (!runIds.length) return [];
  const records = await studyDb.practiceRuns.bulkGet([...runIds]);
  const existing = records.filter((record): record is PracticeRunRecord => Boolean(record));
  const hydrated = await hydratePracticeRunRecords(existing);
  const byId = new Map(hydrated.map((run) => [run.id, run]));
  return runIds.map((runId) => byId.get(runId));
}

export async function putPracticeRunRecordInTx(run: PracticeRun): Promise<void> {
  await studyDb.practiceRuns.put(practiceRunRecord(run));
}

/** Persist already-normalized run metadata without hydrating child relations. */
export async function putPracticeRunMetadataInTx(record: PracticeRunRecord): Promise<void> {
  await studyDb.practiceRuns.put(record);
}

export async function deletePracticeRunBundleInTx(runId: string): Promise<void> {
  await Promise.all([
    studyDb.practiceRunSources.where("runId").equals(runId).delete(),
    studyDb.practiceRunItems.where("runId").equals(runId).delete(),
  ]);
  await studyDb.practiceRuns.delete(runId);
}
