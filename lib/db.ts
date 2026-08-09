import Dexie, { type EntityTable, type InsertType, type Table } from "dexie";
import { addAttemptToDailyStats, addAttemptToStats, attemptDailyKey, calendarDate } from "./practice-metrics";
import type {
  Attempt,
  AttemptDailyStats,
  AttemptStats,
  Bank,
  BankFolder,
  Note,
  PracticeRun,
  PracticeAnswerState,
  PracticeRunStats,
  ActivePractice,
  Question,
  QuestionGroup,
  SyncEvent,
  SyncCheckpointV4,
  SyncCheckpointCache,
  SyncArchiveEntry,
  SyncArchiveEntryKind,
  SyncFile,
  SyncFileMarker,
  SyncMeta,
  SyncTombstone,
} from "./types";

export const SYNC_V4_RETENTION = {
  recentAttempts: 2_000,
  recentPracticeRuns: 100,
  dailyStatsDays: 35,
} as const;

class StudyDatabase extends Dexie {
  banks!: EntityTable<Bank, "id">;
  bankFolders!: EntityTable<BankFolder, "id">;
  questions!: EntityTable<Question, "id">;
  attempts!: EntityTable<Attempt, "id">;
  attemptStats!: EntityTable<AttemptStats, "questionId">;
  attemptDailyStats!: EntityTable<AttemptDailyStats, "key">;
  notes!: EntityTable<Note, "questionId">;
  practiceRuns!: EntityTable<PracticeRun, "id">;
  practiceRunStats!: EntityTable<PracticeRunStats, "bankId">;
  questionGroups!: EntityTable<QuestionGroup, "id">;
  events!: EntityTable<SyncEvent, "id">;
  syncFiles!: EntityTable<SyncFile, "path">;
  tombstones!: EntityTable<SyncTombstone, "key">;
  syncMeta!: EntityTable<SyncMeta, "key">;
  /**
   * Archive rows downloaded during a full restore.  These tables are kept
   * separate from the live history tables until the restore commit succeeds.
   */
  syncRestoreAttempts!: EntityTable<Attempt, "id">;
  syncRestorePracticeRuns!: EntityTable<PracticeRun, "id">;
  syncArchiveEntries!: EntityTable<SyncArchiveEntry, "key">;

  constructor() {
    super("memory-line-study");
    this.version(10).stores({
      banks: "id, folderId, sortOrder, importedAt, updatedAt",
      bankFolders: "id, sortOrder, updatedAt",
      questions: "id, bankId, [bankId+sortOrder], type, *tags, normalizedStem",
      attempts: "id, questionId, bankId, runId, correct, createdAt, deviceId",
      attemptStats: "questionId, bankId, latestAttemptAt",
      attemptDailyStats: "key, date, questionId, bankId",
      notes: "questionId, updatedAt",
      practiceRuns: "id, status, [status+updatedAt], startedAt, updatedAt",
      practiceRunStats: "bankId, latestUpdatedAt",
      questionGroups: "id, type, updatedAt",
      events: "id, synced, createdAt, deviceId",
      syncFiles: "path, sha, appliedAt",
      tombstones: "key, entityType, entityId, deletedAt",
      syncMeta: "key, updatedAt",
      syncRestoreAttempts: "id, questionId, bankId, runId, correct, createdAt, deviceId",
      syncRestorePracticeRuns: "id, status, startedAt, updatedAt",
      syncArchiveEntries: "key, kind, id",
    }).upgrade(async (transaction) => {
      // sortOrder is part of the question identity from v10 onward. Existing
      // local rows are assigned a stable order once during the schema upgrade;
      // later reads and syncs never have to reconstruct order from event logs.
      const questions = await transaction.table<Question>("questions").toArray();
      const byBank = new Map<string, Question[]>();
      for (const question of questions) byBank.set(question.bankId, [...(byBank.get(question.bankId) ?? []), question]);
      const updates: Question[] = [];
      for (const rows of byBank.values()) {
        rows.sort((left, right) => {
          const leftOrder = Number.isFinite(left.sortOrder) ? left.sortOrder : Number.MAX_SAFE_INTEGER;
          const rightOrder = Number.isFinite(right.sortOrder) ? right.sortOrder : Number.MAX_SAFE_INTEGER;
          return leftOrder - rightOrder || left.id.localeCompare(right.id);
        });
        rows.forEach((question, index) => {
          if (!Number.isFinite(question.sortOrder)) updates.push({ ...question, sortOrder: index });
        });
      }
      if (updates.length) await transaction.table<Question>("questions").bulkPut(updates);
    });
  }
}

export const db = new StudyDatabase();

function runBankIds(run: PracticeRun) {
  return ["__all__", ...new Set(run.bankIds?.length ? run.bankIds : [run.bankId])];
}

function submittedAnswersChanged(
  previous: Record<string, PracticeAnswerState> | undefined,
  next: Record<string, PracticeAnswerState>,
) {
  const questionIds = new Set([...Object.keys(previous ?? {}), ...Object.keys(next)]);
  for (const questionId of questionIds) {
    const before = previous?.[questionId];
    const after = next[questionId];
    if (!before?.submitted && !after?.submitted) continue;
    if (Boolean(before?.submitted) !== Boolean(after?.submitted)
      || Boolean(before?.correct) !== Boolean(after?.correct)
      || [...(before?.selected ?? [])].sort().join("") !== [...(after?.selected ?? [])].sort().join("")) return true;
  }
  return false;
}

async function updatePracticeRunStats(previous: PracticeRun | undefined, next: PracticeRun | undefined) {
  const bankIds = new Set([...(previous ? runBankIds(previous) : []), ...(next ? runBankIds(next) : [])]);
  for (const bankId of bankIds) {
    const current = await db.practiceRunStats.get(bankId) ?? { bankId, total: 0, completed: 0, inProgress: 0, abandoned: 0, latestUpdatedAt: "" };
    if (previous && runBankIds(previous).includes(bankId)) {
      current.total = Math.max(0, current.total - 1);
      if (previous.status === "completed") current.completed = Math.max(0, current.completed - 1);
      else if (previous.status === "abandoned") current.abandoned = Math.max(0, current.abandoned - 1);
      else current.inProgress = Math.max(0, current.inProgress - 1);
    }
    if (next && runBankIds(next).includes(bankId)) {
      current.total += 1;
      if (next.status === "completed") current.completed += 1;
      else if (next.status === "abandoned") current.abandoned += 1;
      else current.inProgress += 1;
      if (next.updatedAt > current.latestUpdatedAt) current.latestUpdatedAt = next.updatedAt;
    }
    if (current.total) await db.practiceRunStats.put(current);
    else await db.practiceRunStats.delete(bankId);
  }
}

export function makeId(prefix = "evt") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID()}`;
}

export function getDeviceId() {
  if (typeof window === "undefined") return "server";
  const key = "study-device-id";
  let value = localStorage.getItem(key);
  if (!value) {
    value = `device_${crypto.randomUUID().slice(0, 12)}`;
    localStorage.setItem(key, value);
  }
  return value;
}

export function nextSyncSequence(deviceId = getDeviceId()) {
  if (typeof localStorage === "undefined") return Date.now();
  const key = `study-sync-sequence:${deviceId}`;
  const next = Math.max(Date.now() * 1_000, Number(localStorage.getItem(key)) || 0) + 1;
  localStorage.setItem(key, String(next));
  return next;
}

export function normalizeStem(value: string) {
  return value
    .replace(/\s+/g, "")
    .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[（]([^）]*?分)[）]$/, "")
    .replace(/。$/, "")
    .trim();
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function importQuestionBank(fileName: string, raw: unknown) {
  const source = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw && Array.isArray((raw as { questions?: unknown[] }).questions)
      ? (raw as { questions: unknown[] }).questions
      : null;
  if (!source) throw new Error("未找到题目数组。支持数组或 { questions: [] } 格式。");

  const bankName = fileName.replace(/\.(json|txt)$/i, "");
  if (!/^送电线路工-(初级工|中级工|高级工|技师)$/.test(bankName)) {
    throw new Error("当前版本只保留送电线路工的初级工、中级工、高级工和技师题库。");
  }
  const bankId = await sha256(`${bankName}:${JSON.stringify(source)}`);
  const existingBank = await db.banks.get(bankId);
  const importedDisplayName = existingBank?.displayName?.trim() || bankName;
  const questions: Question[] = [];

  for (const [sortOrder, item] of source.entries()) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const stem = String(row.q ?? row.question ?? row.stem ?? "").trim();
    const optionsRaw = row.a ?? row.options;
    const options = Array.isArray(optionsRaw) ? optionsRaw.map(String) : [];
    const answerRaw = row.ans ?? row.answer;
    const answer = Array.isArray(answerRaw) ? answerRaw.join("") : String(answerRaw ?? "");
    if (!stem || !options.length || !answer) continue;
    const normalizedStem = normalizeStem(stem);
    const id = await sha256(`${bankName}:${normalizedStem}:${JSON.stringify(options)}`);
    const type = options.length === 2 && options[0] === "正确" && options[1] === "错误"
      ? "判断"
      : answer.replace(/[^A-Z]/gi, "").length > 1 ? "多选" : "单选";
    questions.push({
      id,
      bankId,
      bankName: importedDisplayName,
      sortOrder,
      stem,
      normalizedStem,
      answer: answer.toUpperCase().replace(/[^A-Z]/g, ""),
      options,
      type,
      tags: [],
    });
  }
  if (!questions.length) throw new Error("题库中没有可导入的有效题目。");
  const existingQuestions = await db.questions.bulkGet(questions.map((question) => question.id));
  const mergedQuestions = questions.map((question, index) => existingQuestions[index]?.userUpdatedAt ? { ...existingQuestions[index]!, sortOrder: question.sortOrder } : question);

  const bank: Bank = {
    ...existingBank,
    id: bankId,
    name: bankName,
    questionCount: questions.length,
    sortOrder: existingBank?.sortOrder ?? await db.banks.count(),
    importedAt: new Date().toISOString(),
  };
  const deviceId = getDeviceId();
  const event: SyncEvent = {
    id: makeId("bank"),
    type: "bank.imported",
    payload: { bank, questions: mergedQuestions },
    deviceId,
    sequence: nextSyncSequence(deviceId),
    createdAt: new Date().toISOString(),
    synced: 0,
  };
  await db.transaction("rw", db.banks, db.questions, db.events, async () => {
    await db.banks.put(bank);
    await db.questions.bulkPut(mergedQuestions);
    await db.events.put(event);
  });
  return bank;
}

function bankTitle(bank: Bank) {
  return bank.displayName?.trim() || bank.name;
}

async function refreshBankQuestionCount(bankId: string) {
  const bank = await db.banks.get(bankId);
  if (!bank) return;
  const questionCount = await db.questions.where("bankId").equals(bankId).count();
  if (bank.questionCount !== questionCount) await db.banks.put({ ...bank, questionCount });
}

async function putSyncEvent(type: SyncEvent["type"], payload: unknown, createdAt = new Date().toISOString()) {
  const deviceId = getDeviceId();
  await db.events.put({ id: makeId("evt"), type, payload, deviceId, sequence: nextSyncSequence(deviceId), createdAt, synced: 0 });
}

function tombstoneKey(entityType: SyncTombstone["entityType"], entityId: string) {
  return `${entityType}:${entityId}`;
}

function compareClock(
  leftTime: string | undefined,
  leftDevice: string | undefined,
  leftTie: string | undefined,
  rightTime: string | undefined,
  rightDevice: string | undefined,
  rightTie: string | undefined,
) {
  return (leftTime ?? "").localeCompare(rightTime ?? "")
    || (leftDevice ?? "").localeCompare(rightDevice ?? "")
    || (leftTie ?? "").localeCompare(rightTie ?? "");
}

async function putTombstone(entityType: SyncTombstone["entityType"], entityId: string, deletedAt: string, deviceId: string, eventId: string) {
  const key = tombstoneKey(entityType, entityId);
  const current = await db.tombstones.get(key);
  const incoming: SyncTombstone = { key, entityType, entityId, deletedAt, deviceId, eventId };
  if (!current || compareClock(deletedAt, deviceId, eventId, current.deletedAt, current.deviceId, current.eventId) > 0) {
    await db.tombstones.put(incoming);
  }
  return incoming;
}

async function isDeletedAfter(entityType: SyncTombstone["entityType"], entityId: string, changedAt: string, deviceId = "", eventId = "") {
  const deleted = await db.tombstones.get(tombstoneKey(entityType, entityId));
  return Boolean(deleted && compareClock(deleted.deletedAt, deleted.deviceId, deleted.eventId, changedAt, deviceId, eventId) >= 0);
}

async function clearOlderTombstone(entityType: SyncTombstone["entityType"], entityId: string, changedAt: string, deviceId = "", eventId = "") {
  const key = tombstoneKey(entityType, entityId);
  const deleted = await db.tombstones.get(key);
  if (deleted && compareClock(changedAt, deviceId, eventId, deleted.deletedAt, deleted.deviceId, deleted.eventId) > 0) {
    await db.tombstones.delete(key);
  }
}

export async function saveBank(bankId: string, changes: Pick<Bank, "displayName" | "description" | "color" | "folderId" | "sortOrder">) {
  const current = await db.banks.get(bankId);
  if (!current) throw new Error("题库不存在或已被删除。");
  const now = new Date().toISOString();
  const bank: Bank = { ...current, ...changes, displayName: changes.displayName?.trim() || undefined, description: changes.description?.trim() || undefined, updatedAt: now, deviceId: getDeviceId() };
  await db.transaction("rw", db.banks, db.questions, db.events, async () => {
    await db.banks.put(bank);
    if (bankTitle(current) !== bankTitle(bank)) await db.questions.where("bankId").equals(bankId).modify({ bankName: bankTitle(bank) });
    await putSyncEvent("bank.updated", bank, now);
  });
  return bank;
}

export async function reorderBanks(bankIds: string[], folderId?: string) {
  const banks = (await db.banks.bulkGet(bankIds)).filter((bank): bank is Bank => Boolean(bank));
  if (!banks.length) return;
  const updatedAt = new Date().toISOString();
  const deviceId = getDeviceId();
  const rows = banks.map((bank, sortOrder) => ({ ...bank, folderId, sortOrder, updatedAt, deviceId }));
  const events: SyncEvent[] = rows.map((bank) => ({
    id: makeId("evt"), type: "bank.updated", payload: bank, deviceId,
    sequence: nextSyncSequence(deviceId), createdAt: updatedAt, synced: 0,
  }));
  await db.transaction("rw", [db.banks, db.events], async () => {
    await db.banks.bulkPut(rows);
    await db.events.bulkPut(events);
  });
}

export async function saveBankFolder(input: Pick<BankFolder, "name" | "description"> & { id?: string }) {
  const current = input.id ? await db.bankFolders.get(input.id) : undefined;
  const now = new Date().toISOString();
  const name = input.name.trim();
  if (!name) throw new Error("请输入文件夹名称。");
  const folder: BankFolder = { id: input.id ?? makeId("folder"), name, description: input.description.trim(), sortOrder: current?.sortOrder ?? await db.bankFolders.count(), createdAt: current?.createdAt ?? now, updatedAt: now, deviceId: getDeviceId() };
  await db.transaction("rw", db.bankFolders, db.events, async () => { await db.bankFolders.put(folder); await putSyncEvent("bankFolder.saved", folder, now); });
  return folder;
}

export async function deleteBankFolder(folderId: string) {
  const now = new Date().toISOString();
  const deviceId = getDeviceId();
  const eventId = makeId("folder-delete");
  const banks = await db.banks.where("folderId").equals(folderId).toArray();
  await db.transaction("rw", db.bankFolders, db.banks, db.questions, db.events, db.tombstones, async () => {
    await db.bankFolders.delete(folderId);
    for (const bank of banks) {
      const updated = { ...bank, folderId: undefined, updatedAt: now, deviceId: getDeviceId() };
      await db.banks.put(updated);
      await putSyncEvent("bank.updated", updated, now);
    }
    await putTombstone("bankFolder", folderId, now, deviceId, eventId);
    await db.events.put({ id: eventId, type: "bankFolder.deleted", payload: { id: folderId, deletedAt: now }, deviceId, sequence: nextSyncSequence(deviceId), createdAt: now, synced: 0 });
  });
}

export async function createQuestion(bankId: string, changes: Pick<Question, "stem" | "options" | "answer" | "type" | "tags">) {
  const bank = await db.banks.get(bankId);
  if (!bank) throw new Error("题库不存在或已被删除。");
  const stem = changes.stem.trim();
  const options = changes.options.map((item) => item.trim());
  const answer = changes.answer.toUpperCase().replace(/[^A-Z]/g, "");
  if (!stem || options.length < 2 || options.some((item) => !item)) throw new Error("题干和所有选项都不能为空。");
  if (!answer || [...answer].some((letter) => letter.charCodeAt(0) - 65 >= options.length)) throw new Error("正确答案超出了现有选项范围。");
  if (changes.type !== "多选" && answer.length !== 1) throw new Error("单选题和判断题只能设置一个正确答案。");
  if (changes.type === "判断" && (options.length !== 2 || options[0] !== "正确" || options[1] !== "错误")) throw new Error("判断题选项必须依次为“正确、错误”。");
  const now = new Date().toISOString();
  const lastQuestion = await db.questions.where("bankId").equals(bankId).sortBy("sortOrder");
  const question: Question = { id: makeId("question"), bankId, bankName: bankTitle(bank), sortOrder: (lastQuestion.at(-1)?.sortOrder ?? -1) + 1, stem, normalizedStem: normalizeStem(stem), answer, options, type: changes.type, tags: [...new Set(changes.tags.map((tag) => tag.trim()).filter(Boolean))], userUpdatedAt: now, userUpdatedBy: getDeviceId() };
  const updatedBank = { ...bank, questionCount: bank.questionCount + 1, updatedAt: now, deviceId: getDeviceId() };
  await db.transaction("rw", db.questions, db.banks, db.events, async () => {
    await db.questions.put(question); await db.banks.put(updatedBank);
    await putSyncEvent("question.created", question, now); await putSyncEvent("bank.updated", updatedBank, now);
  });
  return question;
}

async function deleteQuestionLocal(questionId: string) {
  const question = await db.questions.get(questionId);
  if (!question) return;
  await db.questions.delete(questionId);
  await db.attempts.where("questionId").equals(questionId).delete();
  await db.attemptStats.delete(questionId);
  await db.attemptDailyStats.where("questionId").equals(questionId).delete();
  await db.notes.delete(questionId);
  const groups = await db.questionGroups.filter((group) => group.items.some((item) => item.questionId === questionId)).toArray();
  await db.questionGroups.bulkPut(groups.map((group) => ({ ...group, items: group.items.filter((item) => item.questionId !== questionId), updatedAt: new Date().toISOString() })).filter((group) => group.items.length));
  await db.questionGroups.bulkDelete(groups.filter((group) => group.items.length === 1).map((group) => group.id));
}

export async function deleteQuestion(questionId: string) {
  const question = await db.questions.get(questionId);
  if (!question) return;
  const now = new Date().toISOString();
  const deviceId = getDeviceId();
  const eventId = makeId("question-delete");
  const bank = await db.banks.get(question.bankId);
  await db.transaction("rw", [db.questions, db.attempts, db.attemptStats, db.attemptDailyStats, db.notes, db.questionGroups, db.banks, db.events, db.tombstones], async () => {
    await deleteQuestionLocal(questionId);
    if (bank) { const updated = { ...bank, questionCount: Math.max(0, bank.questionCount - 1), updatedAt: now, deviceId: getDeviceId() }; await db.banks.put(updated); await putSyncEvent("bank.updated", updated, now); }
    await putTombstone("question", questionId, now, deviceId, eventId);
    await db.events.put({ id: eventId, type: "question.deleted", payload: { id: questionId, deletedAt: now }, deviceId, sequence: nextSyncSequence(deviceId), createdAt: now, synced: 0 });
  });
}

async function deleteBankLocal(bankId: string) {
  const questionIds = (await db.questions.where("bankId").equals(bankId).primaryKeys()) as string[];
  await db.questions.where("bankId").equals(bankId).delete();
  await db.attempts.where("bankId").equals(bankId).delete();
  await db.attemptStats.where("bankId").equals(bankId).delete();
  await db.attemptDailyStats.where("bankId").equals(bankId).delete();
  await db.notes.bulkDelete(questionIds);
  const groups = await db.questionGroups.filter((group) => group.items.some((item) => questionIds.includes(item.questionId))).toArray();
  for (const group of groups) {
    const items = group.items.filter((item) => !questionIds.includes(item.questionId));
    if (items.length) await db.questionGroups.put({ ...group, items, updatedAt: new Date().toISOString() }); else await db.questionGroups.delete(group.id);
  }
  const affectedRuns = await db.practiceRuns.filter((run) => run.bankId === bankId || run.bankIds.includes(bankId)).toArray();
  for (const run of affectedRuns) await updatePracticeRunStats(run, undefined);
  await db.practiceRuns.bulkDelete(affectedRuns.map((run) => run.id));
  await db.practiceRunStats.delete(bankId);
  await db.banks.delete(bankId);
}

export async function deleteBank(bankId: string) {
  const now = new Date().toISOString();
  const deviceId = getDeviceId();
  const eventId = makeId("bank-delete");
  await db.transaction("rw", [db.banks, db.questions, db.attempts, db.attemptStats, db.attemptDailyStats, db.notes, db.questionGroups, db.practiceRuns, db.practiceRunStats, db.events, db.tombstones], async () => {
    await deleteBankLocal(bankId);
    await putTombstone("bank", bankId, now, deviceId, eventId);
    await db.events.put({ id: eventId, type: "bank.deleted", payload: { id: bankId, deletedAt: now }, deviceId, sequence: nextSyncSequence(deviceId), createdAt: now, synced: 0 });
  });
}

export async function recordAttempt(input: Omit<Attempt, "id" | "createdAt" | "deviceId">) {
  const attempt: Attempt = {
    ...input,
    id: makeId("try"),
    createdAt: new Date().toISOString(),
    deviceId: getDeviceId(),
  };
  const event: SyncEvent = {
    id: makeId("evt"),
    type: "attempt.created",
    payload: attempt,
    deviceId: attempt.deviceId,
    sequence: nextSyncSequence(attempt.deviceId),
    createdAt: attempt.createdAt,
    synced: 0,
  };
  await db.transaction("rw", db.attempts, db.attemptStats, db.attemptDailyStats, db.events, async () => {
    await db.attempts.put(attempt);
    await db.attemptStats.put(addAttemptToStats(await db.attemptStats.get(attempt.questionId), attempt));
    const dailyKey = attemptDailyKey(attempt);
    await db.attemptDailyStats.put(addAttemptToDailyStats(await db.attemptDailyStats.get(dailyKey), attempt));
    await db.events.put(event);
  });
  return attempt;
}

export async function saveNote(questionId: string, content: string) {
  const old = await db.notes.get(questionId);
  if (old?.content === content || (!old && !content.trim())) return old ?? {
    questionId, content: "", revision: 0, updatedAt: "", deviceId: getDeviceId(),
  };
  const note: Note = {
    questionId,
    content,
    revision: (old?.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    deviceId: getDeviceId(),
  };
  await db.transaction("rw", db.notes, db.events, async () => {
    await db.notes.put(note);
    const pending = await db.events.where("synced").equals(0).filter((event) => event.type === "note.upserted" && (event.payload as Note).questionId === questionId).first();
    await db.events.put({
      id: pending?.id ?? makeId("evt"), type: "note.upserted", payload: note,
      deviceId: note.deviceId, sequence: pending?.sequence ?? nextSyncSequence(note.deviceId), createdAt: note.updatedAt, synced: 0,
    });
  });
  return note;
}

export async function savePracticeProgress(session: ActivePractice) {
  const run: PracticeRun = {
    id: session.runId,
    bankId: session.bankId,
    bankIds: session.bankIds?.length ? session.bankIds : [session.bankId],
    bankName: session.bankName,
    mode: session.mode,
    modeLabel: session.modeLabel,
    questionIds: session.questionIds,
    questionTypes: session.questionTypes ?? {},
    answers: session.answers,
    shuffleOptions: Boolean(session.shuffleOptions),
    optionOrders: session.optionOrders ?? {},
    lastAnsweredIndex: session.lastAnsweredIndex,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    status: "in_progress",
    revision: session.revision,
  };
  await db.transaction("rw", db.practiceRuns, db.practiceRunStats, db.events, async () => {
    const existingRun = await db.practiceRuns.get(run.id);
    const deviceId = getDeviceId();
    const savedRun = mergePracticeRuns({ ...run, syncDeviceId: deviceId }, existingRun, deviceId, run.updatedAt);
    await updatePracticeRunStats(existingRun, savedRun);
    await db.practiceRuns.put(savedRun);
    // An empty practice is local draft state.  Publish the run only after a
    // submitted answer changes; unconfirmed selections and navigation do not
    // create noisy sync events.
    const syncRelevantChange = submittedAnswersChanged(existingRun?.answers, savedRun.answers)
      || Boolean(existingRun && existingRun.status !== run.status);
    if (syncRelevantChange) {
      const pending = await db.events.where("synced").equals(0).filter((event) => event.type === "practice.run.saved" && (event.payload as PracticeRun).id === run.id).first();
      await db.events.put({
        id: pending?.id ?? makeId("run"), type: "practice.run.saved", payload: savedRun,
        deviceId, sequence: pending?.sequence ?? nextSyncSequence(deviceId), createdAt: run.updatedAt, synced: 0,
      });
    }
  });
  return session;
}

export async function setPracticeRunStatus(runId: string, status: PracticeRun["status"], answers?: PracticeRun["answers"]) {
  const current = await db.practiceRuns.get(runId);
  if (!current) return;
  const now = new Date().toISOString();
  const candidate: PracticeRun = {
    ...current,
    answers: answers ?? current.answers,
    status,
    updatedAt: now,
    completedAt: status === "completed" ? now : current.completedAt,
    abandonedAt: status === "abandoned" ? now : undefined,
    revision: current.revision + 1,
  };
  let savedRun = candidate;
  await db.transaction("rw", db.practiceRuns, db.practiceRunStats, db.events, async () => {
    const deviceId = getDeviceId();
    const run = mergePracticeRuns({ ...candidate, syncDeviceId: deviceId }, current, deviceId, now);
    savedRun = run;
    await updatePracticeRunStats(current, run);
    await db.practiceRuns.put(run);
    if (!Object.values(run.answers).some((answer) => answer.submitted)) return;
    const pending = await db.events.where("synced").equals(0).filter((event) => event.type === "practice.run.saved" && (event.payload as PracticeRun).id === run.id).first();
    await db.events.put({ id: pending?.id ?? makeId("run"), type: "practice.run.saved", payload: run, deviceId, sequence: pending?.sequence ?? nextSyncSequence(deviceId), createdAt: now, synced: 0 });
  });
  return savedRun;
}

export async function deletePracticeRun(runId: string) {
  const current = await db.practiceRuns.get(runId);
  if (!current) return false;
  if (!Object.values(current.answers).some((answer) => answer.submitted)) {
    await db.transaction("rw", db.practiceRuns, db.practiceRunStats, db.events, async () => {
      await updatePracticeRunStats(current, undefined);
      await db.practiceRuns.delete(runId);
      const pendingSaves = await db.events.where("synced").equals(0).filter((event) => event.type === "practice.run.saved" && (event.payload as PracticeRun).id === runId).toArray();
      if (pendingSaves.length) await db.events.bulkDelete(pendingSaves.map((event) => event.id));
    });
    return true;
  }
  const now = new Date().toISOString();
  const deviceId = getDeviceId();
  const eventId = makeId("run-delete");
  await db.transaction("rw", db.practiceRuns, db.practiceRunStats, db.events, db.tombstones, async () => {
    await updatePracticeRunStats(current, undefined);
    await db.practiceRuns.delete(runId);
    const pendingSaves = await db.events.where("synced").equals(0).filter((event) => event.type === "practice.run.saved" && (event.payload as PracticeRun).id === runId).toArray();
    if (pendingSaves.length) await db.events.bulkDelete(pendingSaves.map((event) => event.id));
    await putTombstone("practiceRun", runId, now, deviceId, eventId);
    await db.events.put({ id: eventId, type: "practice.run.deleted", payload: { id: runId, deletedAt: now }, deviceId, sequence: nextSyncSequence(deviceId), createdAt: now, synced: 0 });
  });
  return true;
}

export async function saveQuestionGroup(input: Pick<QuestionGroup, "name" | "type" | "description" | "items"> & { id?: string }) {
  const current = input.id ? await db.questionGroups.get(input.id) : undefined;
  const now = new Date().toISOString();
  const uniqueItems = input.items.filter((item, index, rows) => rows.findIndex((row) => row.questionId === item.questionId) === index);
  if (!input.name.trim()) throw new Error("请输入题组名称。");
  if (!uniqueItems.length) throw new Error("题组至少需要一道题。");
  const group: QuestionGroup = {
    id: input.id ?? makeId("group"),
    name: input.name.trim(),
    type: input.type,
    description: input.description.trim(),
    items: uniqueItems.map((item) => ({ questionId: item.questionId, note: item.note.trim() })),
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    deviceId: getDeviceId(),
  };
  const event: SyncEvent = {
    id: makeId("evt"),
    type: "questionGroup.saved",
    payload: group,
    deviceId: group.deviceId,
    sequence: nextSyncSequence(group.deviceId),
    createdAt: group.updatedAt,
    synced: 0,
  };
  await db.transaction("rw", db.questionGroups, db.events, async () => {
    await db.questionGroups.put(group);
    await db.events.put(event);
  });
  return group;
}

export async function deleteQuestionGroup(groupId: string) {
  const createdAt = new Date().toISOString();
  const deviceId = getDeviceId();
  const eventId = makeId("group-delete");
  const event: SyncEvent = {
    id: eventId,
    type: "questionGroup.deleted",
    payload: { id: groupId, deletedAt: createdAt },
    deviceId,
    sequence: nextSyncSequence(deviceId),
    createdAt,
    synced: 0,
  };
  await db.transaction("rw", db.questionGroups, db.events, db.tombstones, async () => {
    await db.questionGroups.delete(groupId);
    await putTombstone("questionGroup", groupId, createdAt, deviceId, eventId);
    await db.events.put(event);
  });
}

export async function resetLocalDatabase() {
  await db.delete();
  await db.open();
}

export async function updateQuestion(
  questionId: string,
  changes: Pick<Question, "stem" | "options" | "answer" | "type" | "tags">,
) {
  const current = await db.questions.get(questionId);
  if (!current) throw new Error("题目不存在或已被删除。");
  const stem = changes.stem.trim();
  const options = changes.options.map((item) => item.trim());
  const answer = changes.answer.toUpperCase().replace(/[^A-Z]/g, "");
  if (!stem || options.length < 2 || options.some((item) => !item)) throw new Error("题干和所有选项都不能为空。");
  if (!answer || [...answer].some((letter) => letter.charCodeAt(0) - 65 >= options.length)) throw new Error("正确答案超出了现有选项范围。");
  if (changes.type !== "多选" && answer.length !== 1) throw new Error("单选题和判断题只能设置一个正确答案。");
  if (changes.type === "判断" && (options.length !== 2 || options[0] !== "正确" || options[1] !== "错误")) throw new Error("判断题选项必须依次为“正确、错误”。");
  const updatedAt = new Date().toISOString();
  const question: Question = {
    ...current,
    ...changes,
    stem,
    normalizedStem: normalizeStem(stem),
    options,
    answer,
    tags: [...new Set(changes.tags.map((tag) => tag.trim()).filter(Boolean))],
    userUpdatedAt: updatedAt,
    userUpdatedBy: getDeviceId(),
  };
  const deviceId = question.userUpdatedBy ?? getDeviceId();
  const event: SyncEvent = {
    id: makeId("question"),
    type: "question.updated",
    payload: question,
    deviceId,
    sequence: nextSyncSequence(deviceId),
    createdAt: updatedAt,
    synced: 0,
  };
  await db.transaction("rw", db.questions, db.events, async () => {
    await db.questions.put(question);
    await db.events.put(event);
  });
  return question;
}

export async function toggleQuestionFavorite(questionId: string) {
  const current = await db.questions.get(questionId);
  if (!current) throw new Error("题目不存在或已被删除。");
  const updatedAt = new Date().toISOString();
  const question: Question = {
    ...current,
    favorite: !current.favorite,
    userUpdatedAt: updatedAt,
    userUpdatedBy: getDeviceId(),
  };
  const deviceId = question.userUpdatedBy ?? getDeviceId();
  const event: SyncEvent = {
    id: makeId("question"),
    type: "question.updated",
    payload: question,
    deviceId,
    sequence: nextSyncSequence(deviceId),
    createdAt: updatedAt,
    synced: 0,
  };
  await db.transaction("rw", db.questions, db.events, async () => {
    await db.questions.put(question);
    await db.events.put(event);
  });
  return question;
}

function validSnapshotArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function recentDailyCutoff(days = SYNC_V4_RETENTION.dailyStatsDays) {
  const date = new Date();
  date.setDate(date.getDate() - Math.max(0, days - 1));
  return calendarDate(date);
}

export function validateSyncCheckpoint(checkpoint: unknown): asserts checkpoint is SyncCheckpointV4 {
  if (!checkpoint || typeof checkpoint !== "object" || (checkpoint as SyncCheckpointV4).formatVersion !== 4) {
    throw new Error("远程检查点格式无效或版本不受支持。");
  }
  const value = checkpoint as SyncCheckpointV4;
  const state = value.state;
  if (!state || !validSnapshotArray(state.banks) || !validSnapshotArray(state.bankFolders)
    || !validSnapshotArray(state.questions) || !validSnapshotArray(state.attemptStats)
    || !validSnapshotArray(state.recentAttemptDailyStats) || !validSnapshotArray(state.recentAttempts)
    || !validSnapshotArray(state.notes) || !validSnapshotArray(state.recentPracticeRuns) || !validSnapshotArray(state.practiceRunStats)
    || !validSnapshotArray(state.questionGroups) || !validSnapshotArray(state.tombstones)) {
    throw new Error("远程检查点缺少必要的数据集合。");
  }
  if (!value.cursors || typeof value.cursors !== "object" || Object.values(value.cursors).some((sequence) => !Number.isSafeInteger(sequence) || sequence < 0)) {
    throw new Error("远程检查点的设备游标无效。");
  }
  if (state.recentAttempts.length > SYNC_V4_RETENTION.recentAttempts || state.recentPracticeRuns.length > SYNC_V4_RETENTION.recentPracticeRuns) {
    throw new Error("远程检查点超过 v4 保留上限。");
  }
  const bankIds = new Set(state.banks.map((bank) => bank.id));
  const questionIds = new Set(state.questions.map((question) => question.id));
  if (state.banks.some((bank) => !bank?.id || !/^送电线路工-(初级工|中级工|高级工|技师)$/.test(bank.name))) throw new Error("远程检查点包含不受支持的题库。");
  if (state.questions.some((question) => !question?.id || !bankIds.has(question.bankId))) throw new Error("远程检查点中的题目引用了不存在的题库。");
  if (state.attemptStats.some((stats) => !questionIds.has(stats.questionId) || !bankIds.has(stats.bankId)
    || !Number.isSafeInteger(stats.total) || !Number.isSafeInteger(stats.correct) || !Number.isSafeInteger(stats.wrong)
    || !Number.isSafeInteger(stats.giveUps) || stats.total < 0 || stats.correct < 0 || stats.wrong < 0 || stats.giveUps < 0
    || stats.correct + stats.wrong !== stats.total || stats.giveUps > stats.total
    || !Number.isFinite(stats.totalElapsedMs) || stats.totalElapsedMs < 0
    || !Array.isArray(stats.recentOutcomes) || stats.recentOutcomes.length > 32
    || !Number.isSafeInteger(stats.currentCorrectStreak) || stats.currentCorrectStreak < 0 || stats.currentCorrectStreak > stats.correct
    || !Number.isSafeInteger(stats.correctStreakAfterWrong) || stats.correctStreakAfterWrong < 0
    || stats.correctStreakAfterWrong > stats.currentCorrectStreak
    || (!stats.hasBeenWrong && stats.correctStreakAfterWrong !== 0))) {
    throw new Error("远程检查点中的作答汇总引用或统计无效。");
  }
  if (state.recentAttempts.some((attempt) => !attempt?.id || !questionIds.has(attempt.questionId))) throw new Error("远程检查点中的近期作答引用无效。");
  if (state.practiceRunStats.some((stats) => !Number.isSafeInteger(stats.total) || stats.total < 0
    || !Number.isSafeInteger(stats.completed) || stats.completed < 0
    || !Number.isSafeInteger(stats.inProgress) || stats.inProgress < 0
    || !Number.isSafeInteger(stats.abandoned) || stats.abandoned < 0
    || stats.completed + stats.inProgress + stats.abandoned !== stats.total)) {
    throw new Error("远程检查点中的练习汇总无效。");
  }
  const expected = {
    banks: state.banks.length,
    bankFolders: state.bankFolders.length,
    questions: state.questions.length,
    recentAttempts: state.recentAttempts.length,
    notes: state.notes.length,
    recentPracticeRuns: state.recentPracticeRuns.length,
    questionGroups: state.questionGroups.length,
    tombstones: state.tombstones.length,
  };
  if (!value.counts || Object.entries(expected).some(([key, count]) => value.counts[key as keyof typeof value.counts] !== count)) {
    throw new Error("远程检查点统计与实际内容不一致。");
  }
  const totalAttempts = state.attemptStats.reduce((sum, stats) => sum + stats.total, 0);
  const totalPracticeRuns = state.practiceRunStats.find((stats) => stats.bankId === "__all__")?.total ?? state.recentPracticeRuns.length;
  if (value.counts.totalAttempts !== totalAttempts || value.counts.totalPracticeRuns !== totalPracticeRuns) {
    throw new Error("远程检查点累计统计与汇总表不一致。");
  }
}

/**
 * A checkpoint prepared for a restore transaction.
 *
 * Preparing once lets callers validate a downloaded checkpoint and then pass
 * the same object to both the restore and local-cache paths. The plan keeps
 * only the question-id index needed while filtering question groups; it does
 * not clone any of the checkpoint's row arrays.
 */
export interface SyncCheckpointPlan {
  readonly checkpoint: SyncCheckpointV4;
  readonly questionIds: ReadonlySet<string>;
}

function normalizeQuestionSortOrders(rows: readonly Question[]) {
  const nextByBank = new Map<string, number>();
  for (const question of rows) {
    if (Number.isFinite(question.sortOrder)) {
      nextByBank.set(question.bankId, Math.max(nextByBank.get(question.bankId) ?? 0, question.sortOrder + 1));
    }
  }
  return rows.map((question) => {
    if (Number.isFinite(question.sortOrder)) return question;
    const sortOrder = nextByBank.get(question.bankId) ?? 0;
    nextByBank.set(question.bankId, sortOrder + 1);
    return { ...question, sortOrder };
  });
}

async function normalizeRemoteQuestionSortOrder(incoming: Question, current?: Question) {
  if (Number.isFinite(incoming.sortOrder)) return incoming;
  if (current && Number.isFinite(current.sortOrder)) return { ...incoming, sortOrder: current.sortOrder };
  const rows = await db.questions.where("bankId").equals(incoming.bankId).toArray();
  const sortOrder = rows.reduce((maximum, question) => Number.isFinite(question.sortOrder) ? Math.max(maximum, question.sortOrder) : maximum, -1) + 1;
  return { ...incoming, sortOrder };
}

/** Validate a checkpoint once and build the small index used during apply. */
export function prepareSyncCheckpoint(value: unknown): SyncCheckpointPlan {
  validateSyncCheckpoint(value);
  const questions = normalizeQuestionSortOrders(value.state.questions);
  const checkpoint = questions.some((question, index) => question !== value.state.questions[index])
    ? { ...value, state: { ...value.state, questions } }
    : value;
  return {
    checkpoint,
    questionIds: new Set(questions.map((question) => question.id)),
  };
}

/**
 * All tables that can be touched by a checkpoint restore. Keeping this list in
 * one place gives sync callers a safe transaction scope for work that must
 * happen together with checkpoint application (for example replaying pending
 * events and writing sync-file markers).
 *
 * Dexie's nested read-write transactions join an existing compatible
 * transaction, so `applySyncCheckpoint` can safely be called from the callback
 * passed to this helper.
 */
const syncCheckpointTables = [
  db.banks,
  db.bankFolders,
  db.questions,
  db.attempts,
  db.attemptStats,
  db.attemptDailyStats,
  db.notes,
  db.practiceRuns,
  db.practiceRunStats,
  db.questionGroups,
  db.tombstones,
  db.events,
  db.syncFiles,
  db.syncMeta,
  db.syncRestoreAttempts,
  db.syncRestorePracticeRuns,
  db.syncArchiveEntries,
];

export async function withSyncCheckpointTransaction<T>(work: () => Promise<T>): Promise<T> {
  return db.transaction("rw", syncCheckpointTables, work);
}

/** Alias that describes the same atomic scope from the restore caller's view. */
export const withSyncRestoreTransaction = withSyncCheckpointTransaction;

export async function createSyncCheckpoint(): Promise<SyncCheckpointV4> {
  const [banks, bankFolders, questions, attemptStats, recentAttemptDailyStats, recentAttemptsDescending, notes,
    recentPracticeRunsDescending, practiceRunStats, questionGroups, tombstones, events, cursorRows] = await Promise.all([
    db.banks.toArray(), db.bankFolders.toArray(), db.questions.toArray(), db.attemptStats.toArray(),
    db.attemptDailyStats.where("date").aboveOrEqual(recentDailyCutoff()).toArray(),
    db.attempts.orderBy("createdAt").reverse().limit(SYNC_V4_RETENTION.recentAttempts).toArray(),
    db.notes.toArray(), db.practiceRuns.orderBy("updatedAt").reverse().limit(SYNC_V4_RETENTION.recentPracticeRuns).toArray(), db.practiceRunStats.toArray(),
    db.questionGroups.toArray(), db.tombstones.toArray(), db.events.toArray(),
    db.syncMeta.where("key").startsWith("cursor:").toArray(),
  ]);
  const cursors: Record<string, number> = {};
  for (const row of cursorRows) cursors[row.key.slice("cursor:".length)] = Number(row.value) || 0;
  for (const event of events) {
    if (Number.isSafeInteger(event.sequence) && event.sequence > 0) cursors[event.deviceId] = Math.max(cursors[event.deviceId] ?? 0, event.sequence);
  }
  const recentAttempts = recentAttemptsDescending.reverse();
  const recentPracticeRuns = recentPracticeRunsDescending.reverse();
  const totalAttempts = attemptStats.reduce((sum, stats) => sum + stats.total, 0);
  const checkpoint: SyncCheckpointV4 = {
    formatVersion: 4,
    generatedAt: new Date().toISOString(),
    state: { banks, bankFolders, questions, attemptStats, recentAttemptDailyStats, recentAttempts, notes, recentPracticeRuns, practiceRunStats, questionGroups, tombstones },
    cursors,
    retention: {
      recentAttemptLimit: SYNC_V4_RETENTION.recentAttempts,
      recentPracticeRunLimit: SYNC_V4_RETENTION.recentPracticeRuns,
      dailyStatsDays: SYNC_V4_RETENTION.dailyStatsDays,
      oldestRecentAttemptAt: recentAttempts[0]?.createdAt ?? null,
    },
    counts: {
      banks: banks.length, bankFolders: bankFolders.length, questions: questions.length,
      totalAttempts, recentAttempts: recentAttempts.length, notes: notes.length,
      totalPracticeRuns: practiceRunStats.find((stats) => stats.bankId === "__all__")?.total ?? recentPracticeRuns.length, recentPracticeRuns: recentPracticeRuns.length,
      questionGroups: questionGroups.length, tombstones: tombstones.length,
    },
  };
  validateSyncCheckpoint(checkpoint);
  return checkpoint;
}

export interface SyncCheckpointCacheInput {
  path: string;
  owner: string;
  repo: string;
  branch: string;
  checkpoint: SyncCheckpointV4 | SyncCheckpointPlan;
  markers?: readonly SyncFileMarker[];
  cachedAt?: string;
}

/**
 * Build the local cache row from an already-built checkpoint. No database read
 * occurs here, so callers can cache the exact checkpoint that was downloaded
 * and validated during sync without a second full-table scan.
 */
export function buildSyncCheckpointCacheFile(input: SyncCheckpointCacheInput): SyncFile {
  const plan = isSyncCheckpointPlan(input.checkpoint) ? input.checkpoint : prepareSyncCheckpoint(input.checkpoint);
  const cachedAt = input.cachedAt ?? new Date().toISOString();
  const snapshot: SyncCheckpointCache = {
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    cachedAt,
    snapshot: plan.checkpoint,
    markers: (input.markers ?? []).map((marker) => ({ ...marker })),
  };
  return {
    path: input.path,
    sha: `local-${plan.checkpoint.generatedAt}`,
    appliedAt: cachedAt,
    remoteCache: snapshot,
  };
}

export async function saveSyncCheckpointCache(input: SyncCheckpointCacheInput) {
  const file = buildSyncCheckpointCacheFile(input);
  await db.syncFiles.put(file);
  return { cachedAt: file.remoteCache!.cachedAt, counts: file.remoteCache!.snapshot.counts, file };
}

/** Short name for callers that already use “cache” terminology. */
export const cacheSyncCheckpoint = saveSyncCheckpointCache;

export interface SyncCheckpointApplyOptions {
  /** Keep sync-file markers so the caller can update them in the same transaction. */
  preserveSyncFiles?: boolean;
}

function isSyncCheckpointPlan(value: SyncCheckpointV4 | SyncCheckpointPlan): value is SyncCheckpointPlan {
  return "checkpoint" in value && "questionIds" in value;
}

/**
 * Apply a prepared checkpoint inside the current transaction.
 *
 * This function intentionally has no transaction boundary of its own. It is
 * exported for restore flows that need to stage additional writes (pending
 * events or sync markers) and commit all of them as one unit.
 */
async function applyPreparedSyncCheckpointInTransaction(
  plan: SyncCheckpointPlan,
  options: SyncCheckpointApplyOptions = {},
) {
  const { checkpoint } = plan;
  const clearTables = [
    db.banks,
    db.bankFolders,
    db.questions,
    db.attempts,
    db.attemptStats,
    db.attemptDailyStats,
    db.notes,
    db.practiceRuns,
    db.practiceRunStats,
    db.questionGroups,
    db.tombstones,
    db.events,
    ...(options.preserveSyncFiles ? [] : [db.syncFiles]),
  ];
  await Promise.all(clearTables.map((table) => table.clear()));

  // Archive indexes are local lazy-history bookkeeping. Preserve them without
  // materialising the whole syncMeta table in JavaScript memory.
  await db.syncMeta.filter((row) => !row.key.startsWith("archive-index:")).delete();
  const groups = checkpoint.state.questionGroups
    .map((group) => ({ ...group, items: group.items.filter((item) => plan.questionIds.has(item.questionId)) }))
    .filter((group) => group.items.length);
  await Promise.all([
    db.banks.bulkPut(checkpoint.state.banks), db.bankFolders.bulkPut(checkpoint.state.bankFolders),
    db.questions.bulkPut(checkpoint.state.questions), db.attempts.bulkPut(checkpoint.state.recentAttempts),
    db.attemptStats.bulkPut(checkpoint.state.attemptStats), db.attemptDailyStats.bulkPut(checkpoint.state.recentAttemptDailyStats),
    db.notes.bulkPut(checkpoint.state.notes), db.practiceRuns.bulkPut(checkpoint.state.recentPracticeRuns), db.practiceRunStats.bulkPut(checkpoint.state.practiceRunStats),
    db.questionGroups.bulkPut(groups), db.tombstones.bulkPut(checkpoint.state.tombstones),
    db.syncMeta.bulkPut(Object.entries(checkpoint.cursors).map(([deviceId, sequence]) => ({ key: `cursor:${deviceId}`, value: sequence, updatedAt: checkpoint.generatedAt }))),
    db.syncMeta.put({ key: "remote-counts", value: checkpoint.counts, updatedAt: checkpoint.generatedAt }),
  ]);
}

/** Apply a prepared checkpoint, opening a transaction when the caller has not. */
export async function applyPreparedSyncCheckpoint(
  plan: SyncCheckpointPlan,
  options: SyncCheckpointApplyOptions = {},
) {
  if (Dexie.currentTransaction?.db === db) {
    await applyPreparedSyncCheckpointInTransaction(plan, options);
    return;
  }
  await withSyncCheckpointTransaction(() => applyPreparedSyncCheckpointInTransaction(plan, options));
}

/**
 * Delete rows left by an interrupted full restore.  A failed commit itself is
 * transactional and therefore leaves the stage intact; callers can invoke
 * this explicitly when they no longer need to retry that restore.
 */
export async function clearSyncRestoreStage() {
  const clear = async () => {
    await Promise.all([db.syncRestoreAttempts.clear(), db.syncRestorePracticeRuns.clear()]);
  };
  if (Dexie.currentTransaction?.db === db) {
    await clear();
    return;
  }
  await db.transaction("rw", [db.syncRestoreAttempts, db.syncRestorePracticeRuns], clear);
}

function archiveEntryKey(kind: SyncArchiveEntryKind, id: string) {
  return `${kind}:${id}`;
}

function uniqueArchiveIds(ids: readonly string[]) {
  return [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
}

/**
 * Mark archive rows as materialised, in bounded writes.  This is intentionally
 * usable from a restore finalizer: when called inside commitStagedSyncRestore
 * it joins that transaction and rolls back with the checkpoint on failure.
 */
export async function markSyncArchiveEntries(kind: SyncArchiveEntryKind, ids: readonly string[]) {
  const uniqueIds = uniqueArchiveIds(ids);
  if (!uniqueIds.length) return;
  const mark = async () => {
    for (let offset = 0; offset < uniqueIds.length; offset += syncRestoreCopyChunkSize) {
      const rows: SyncArchiveEntry[] = uniqueIds
        .slice(offset, offset + syncRestoreCopyChunkSize)
        .map((id) => ({ key: archiveEntryKey(kind, id), kind, id }));
      await db.syncArchiveEntries.bulkPut(rows);
    }
  };
  if (Dexie.currentTransaction?.db === db) {
    await mark();
    return;
  }
  await db.transaction("rw", db.syncArchiveEntries, mark);
}

/** Check whether one archive row has already been materialised locally. */
export async function hasSyncArchiveEntry(kind: SyncArchiveEntryKind, id: string) {
  if (!id) return false;
  const check = async () => Boolean(await db.syncArchiveEntries.get(archiveEntryKey(kind, id)));
  if (Dexie.currentTransaction?.db === db) return check();
  return db.transaction("r", db.syncArchiveEntries, check);
}

/**
 * Return only archive ids that are not indexed yet.  Existing-row reads are
 * performed with bulkGet in chunks so a large catalog never becomes a large
 * temporary row array.
 */
export async function filterUnarchivedSyncIds(kind: SyncArchiveEntryKind, ids: readonly string[]) {
  const uniqueIds = uniqueArchiveIds(ids);
  if (!uniqueIds.length) return [];
  const filter = async () => {
    const missing: string[] = [];
    for (let offset = 0; offset < uniqueIds.length; offset += syncRestoreCopyChunkSize) {
      const chunk = uniqueIds.slice(offset, offset + syncRestoreCopyChunkSize);
      const existing = await db.syncArchiveEntries.bulkGet(chunk.map((id) => archiveEntryKey(kind, id)));
      for (let index = 0; index < chunk.length; index += 1) if (!existing[index]) missing.push(chunk[index]);
    }
    return missing;
  };
  if (Dexie.currentTransaction?.db === db) return filter();
  return db.transaction("r", db.syncArchiveEntries, filter);
}

/** Return the subset of ids already present in the archive index. */
export async function bulkHasSyncArchiveEntries(kind: SyncArchiveEntryKind, ids: readonly string[]) {
  const missing = new Set(await filterUnarchivedSyncIds(kind, ids));
  return new Set(uniqueArchiveIds(ids).filter((id) => !missing.has(id)));
}

/** Clear the bounded archive-materialisation index. */
export async function clearSyncArchiveEntries() {
  const clear = async () => { await db.syncArchiveEntries.clear(); };
  if (Dexie.currentTransaction?.db === db) {
    await clear();
    return;
  }
  await db.transaction("rw", db.syncArchiveEntries, clear);
}

/**
 * Stage one downloaded archive segment.  The caller should invoke this once
 * per segment instead of collecting the complete archive in a JS array.
 */
export async function stageSyncRestoreAttempts(rows: readonly Attempt[]) {
  if (!rows.length) return;
  const stage = async () => { await db.syncRestoreAttempts.bulkPut(rows); };
  if (Dexie.currentTransaction?.db === db) {
    await stage();
    return;
  }
  await db.transaction("rw", db.syncRestoreAttempts, stage);
}

/** Stage one downloaded practice-run archive segment. */
export async function stageSyncRestorePracticeRuns(rows: readonly PracticeRun[]) {
  if (!rows.length) return;
  const stage = async () => { await db.syncRestorePracticeRuns.bulkPut(rows); };
  if (Dexie.currentTransaction?.db === db) {
    await stage();
    return;
  }
  await db.transaction("rw", db.syncRestorePracticeRuns, stage);
}

const syncRestoreCopyChunkSize = 500;

/**
 * Move a stage table into its live counterpart in bounded chunks.  Reading a
 * chunk and deleting it before fetching the next one keeps memory bounded by
 * the segment size while preserving idempotence for duplicate archive rows.
 */
async function copyStagedRows<T extends { id: string }>(
  source: Table<T, T["id"], InsertType<T, "id">>,
  target: Table<T, T["id"], InsertType<T, "id">>,
  archiveKind: SyncArchiveEntryKind,
) {
  let copied = 0;
  while (true) {
    const rows = await source.toCollection().limit(syncRestoreCopyChunkSize).toArray();
    if (!rows.length) break;
    await target.bulkPut(rows);
    await markSyncArchiveEntries(archiveKind, rows.map((row) => row.id));
    await source.bulkDelete(rows.map((row) => row.id));
    copied += rows.length;
  }
  return copied;
}

export type SyncRestoreFinalize = () => Promise<void> | void;

/**
 * Atomically apply a prepared checkpoint and commit all staged archive rows.
 * `finalize` runs between checkpoint application and stage promotion, while
 * the same Dexie transaction is active; it can therefore replay hot events and
 * write sync-file markers without exposing a partially restored database.
 * Attempt and practice-run aggregate tables are intentionally not rebuilt
 * here: their checkpoint values already include the archived history.
 */
export async function commitStagedSyncRestore(
  plan: SyncCheckpointPlan,
  finalize?: SyncRestoreFinalize,
) {
  const commit = async () => {
    await applyPreparedSyncCheckpointInTransaction(plan);
    await finalize?.();
    const [attempts, practiceRuns] = await Promise.all([
      copyStagedRows(db.syncRestoreAttempts, db.attempts, "attempts"),
      copyStagedRows(db.syncRestorePracticeRuns, db.practiceRuns, "practice-runs"),
    ]);
    return { attempts, practiceRuns };
  };
  if (Dexie.currentTransaction?.db === db) return commit();
  return withSyncCheckpointTransaction(commit);
}

/**
 * Replace the local v4 state atomically. Passing a plan avoids validating and
 * indexing the same checkpoint again when the caller also caches it.
 */
export async function applySyncCheckpoint(
  input: SyncCheckpointV4 | SyncCheckpointPlan,
  options: SyncCheckpointApplyOptions = {},
) {
  const plan = isSyncCheckpointPlan(input) ? input : prepareSyncCheckpoint(input);
  await applyPreparedSyncCheckpoint(plan, options);
}

function practiceRunWins(incoming: PracticeRun, current: PracticeRun | undefined, deviceId = "", tie = "") {
  if (!current) return true;
  if (incoming.revision !== current.revision) return incoming.revision > current.revision;
  return compareClock(incoming.updatedAt, incoming.syncDeviceId ?? deviceId, incoming.syncEventId ?? tie, current.updatedAt, current.syncDeviceId, current.syncEventId) > 0;
}

function practiceAnswerWins(
  incoming: PracticeAnswerState,
  current: PracticeAnswerState,
  incomingRun: PracticeRun,
  currentRun: PracticeRun,
  incomingDeviceId = "",
  incomingTie = "",
) {
  const clock = compareClock(
    incoming.updatedAt ?? incomingRun.updatedAt,
    incoming.deviceId ?? incomingRun.syncDeviceId ?? incomingDeviceId,
    incoming.eventId ?? incomingRun.syncEventId ?? incomingTie,
    current.updatedAt ?? currentRun.updatedAt,
    current.deviceId ?? currentRun.syncDeviceId,
    current.eventId ?? currentRun.syncEventId,
  );
  if (clock) return clock > 0;
  // Old rows can legitimately have identical parent clocks and no answer
  // metadata. A deterministic content tie-breaker keeps all devices convergent.
  return JSON.stringify(incoming) > JSON.stringify(current);
}

/**
 * Merge the mutable part of a practice run per question. Run metadata/status
 * still uses LWW, while answers from different devices form a union and only
 * competing edits to the same question use the answer clock.
 */
export function mergePracticeRuns(
  incoming: PracticeRun,
  current: PracticeRun | undefined,
  incomingDeviceId = "",
  incomingTie = "",
) {
  if (!current) return incoming;
  const incomingIsWinner = practiceRunWins(incoming, current, incomingDeviceId, incomingTie);
  const base = incomingIsWinner ? incoming : current;
  const answers: Record<string, PracticeAnswerState> = { ...current.answers };
  for (const [questionId, answer] of Object.entries(incoming.answers)) {
    const existing = answers[questionId];
    if (!existing || practiceAnswerWins(answer, existing, incoming, current, incomingDeviceId, incomingTie)) answers[questionId] = answer;
  }
  const lastSubmittedIndex = base.questionIds.reduce(
    (last, questionId, index) => answers[questionId]?.submitted ? index : last,
    -1,
  );
  return {
    ...base,
    answers,
    revision: Math.max(incoming.revision, current.revision),
    lastAnsweredIndex: lastSubmittedIndex >= 0 ? lastSubmittedIndex : base.lastAnsweredIndex,
  };
}

export async function applyRemoteEvents(events: SyncEvent[]) {
  const ordered = [...events].sort((a, b) => compareClock(a.createdAt, a.deviceId, a.id, b.createdAt, b.deviceId, b.id));
  await db.transaction(
    "rw",
    [db.banks, db.bankFolders, db.questions, db.attempts, db.attemptStats, db.attemptDailyStats, db.notes, db.practiceRuns, db.practiceRunStats,
      db.questionGroups, db.events, db.tombstones, db.syncMeta],
    async () => {
      for (const event of ordered) {
        if (!event?.id || !event.type || !event.createdAt || await db.events.get(event.id)) continue;
        if (event.type === "bank.imported") {
          const payload = event.payload as { bank: Bank; questions: Question[] };
          if (!payload?.bank || !Array.isArray(payload.questions) || !/^送电线路工-(初级工|中级工|高级工|技师)$/.test(payload.bank.name)) {
            await db.events.put({ ...event, synced: 1 });
            continue;
          }
          if (!await isDeletedAfter("bank", payload.bank.id, event.createdAt, event.deviceId, event.id)) {
            await clearOlderTombstone("bank", payload.bank.id, event.createdAt, event.deviceId, event.id);
            const remoteBank: Bank = { ...payload.bank, deviceId: payload.bank.deviceId ?? event.deviceId, syncEventId: event.id };
            const currentBank = await db.banks.get(payload.bank.id);
            const bank = currentBank ? { ...remoteBank, displayName: currentBank.displayName, description: currentBank.description, color: currentBank.color, folderId: currentBank.folderId, sortOrder: currentBank.sortOrder, updatedAt: currentBank.updatedAt, deviceId: currentBank.deviceId, syncEventId: currentBank.syncEventId } : remoteBank;
            await db.banks.put(bank);
            const merged: Question[] = [];
            for (const [remoteIndex, remoteQuestion] of payload.questions.entries()) {
              const orderedQuestion = Number.isFinite(remoteQuestion.sortOrder) ? remoteQuestion : { ...remoteQuestion, sortOrder: remoteIndex };
              const incoming: Question = orderedQuestion.userUpdatedAt ? { ...orderedQuestion, syncEventId: event.id } : { ...orderedQuestion, bankName: bankTitle(bank), tags: [], syncEventId: event.id };
              if (await isDeletedAfter("question", incoming.id, incoming.userUpdatedAt ?? event.createdAt, incoming.userUpdatedBy ?? event.deviceId, event.id)) continue;
              const current = await db.questions.get(incoming.id);
              merged.push(current?.userUpdatedAt ? current : incoming);
            }
            if (merged.length) await db.questions.bulkPut(merged);
            await refreshBankQuestionCount(bank.id);
          }
        } else if (event.type === "bank.updated") {
          const incoming = { ...(event.payload as Bank), syncEventId: event.id };
          const changedAt = incoming.updatedAt ?? event.createdAt;
          if (!await isDeletedAfter("bank", incoming.id, changedAt, incoming.deviceId ?? event.deviceId, event.id)) {
            await clearOlderTombstone("bank", incoming.id, changedAt, incoming.deviceId ?? event.deviceId, event.id);
            const current = await db.banks.get(incoming.id);
            if (!current || compareClock(changedAt, incoming.deviceId ?? event.deviceId, event.id, current.updatedAt ?? current.importedAt, current.deviceId, current.syncEventId) > 0) {
              const questionCount = await db.questions.where("bankId").equals(incoming.id).count();
              await db.banks.put({ ...incoming, questionCount });
              await db.questions.where("bankId").equals(incoming.id).modify({ bankName: bankTitle(incoming) });
            }
          }
        } else if (event.type === "bank.deleted") {
          const payload = event.payload as { id: string; deletedAt?: string };
          const deletedAt = payload.deletedAt ?? event.createdAt;
          const current = await db.banks.get(payload.id);
          if (!current || compareClock(deletedAt, event.deviceId, event.id, current.updatedAt ?? current.importedAt, current.deviceId, current.syncEventId) >= 0) {
            await putTombstone("bank", payload.id, deletedAt, event.deviceId, event.id);
            await deleteBankLocal(payload.id);
          }
        } else if (event.type === "bankFolder.saved") {
          const incoming = { ...(event.payload as BankFolder), syncEventId: event.id };
          if (!await isDeletedAfter("bankFolder", incoming.id, incoming.updatedAt, incoming.deviceId, event.id)) {
            await clearOlderTombstone("bankFolder", incoming.id, incoming.updatedAt, incoming.deviceId, event.id);
            const current = await db.bankFolders.get(incoming.id);
            if (!current || compareClock(incoming.updatedAt, incoming.deviceId, event.id, current.updatedAt, current.deviceId, current.syncEventId) > 0) await db.bankFolders.put(incoming);
          }
        } else if (event.type === "bankFolder.deleted") {
          const payload = event.payload as { id: string; deletedAt?: string };
          const deletedAt = payload.deletedAt ?? event.createdAt;
          const current = await db.bankFolders.get(payload.id);
          if (!current || compareClock(deletedAt, event.deviceId, event.id, current.updatedAt, current.deviceId, current.syncEventId) >= 0) {
            await putTombstone("bankFolder", payload.id, deletedAt, event.deviceId, event.id);
            await db.bankFolders.delete(payload.id);
            await db.banks.where("folderId").equals(payload.id).modify({ folderId: undefined });
          }
        } else if (event.type === "attempt.created") {
          const incoming = event.payload as Attempt;
          if (incoming?.id && await db.questions.get(incoming.questionId) && !await db.attempts.get(incoming.id)) {
            await db.attempts.put(incoming);
            await db.attemptStats.put(addAttemptToStats(await db.attemptStats.get(incoming.questionId), incoming));
            const dailyKey = attemptDailyKey(incoming);
            await db.attemptDailyStats.put(addAttemptToDailyStats(await db.attemptDailyStats.get(dailyKey), incoming));
          }
        } else if (event.type === "note.upserted") {
          const incoming = { ...(event.payload as Note), syncEventId: event.id };
          const current = await db.notes.get(incoming.questionId);
          if (!current || compareClock(incoming.updatedAt, incoming.deviceId, event.id, current.updatedAt, current.deviceId, current.syncEventId) > 0) await db.notes.put(incoming);
        } else if (event.type === "practice.run.saved") {
          const incoming = { ...(event.payload as PracticeRun), syncDeviceId: event.deviceId, syncEventId: event.id };
          if (!await isDeletedAfter("practiceRun", incoming.id, incoming.updatedAt, event.deviceId, event.id)) {
            await clearOlderTombstone("practiceRun", incoming.id, incoming.updatedAt, event.deviceId, event.id);
            const current = await db.practiceRuns.get(incoming.id);
            const merged = mergePracticeRuns(incoming, current, event.deviceId, event.id);
            await updatePracticeRunStats(current, merged);
            await db.practiceRuns.put(merged);
          }
        } else if (event.type === "practice.run.deleted") {
          const payload = event.payload as { id: string; deletedAt?: string };
          const deletedAt = payload.deletedAt ?? event.createdAt;
          const current = await db.practiceRuns.get(payload.id);
          if (!current || compareClock(deletedAt, event.deviceId, event.id, current.updatedAt, current.syncDeviceId, current.syncEventId) >= 0) {
            await putTombstone("practiceRun", payload.id, deletedAt, event.deviceId, event.id);
            if (current) await updatePracticeRunStats(current, undefined);
            await db.practiceRuns.delete(payload.id);
          }
        } else if (event.type === "questionGroup.saved") {
          const incoming = { ...(event.payload as QuestionGroup), syncEventId: event.id };
          if (!await isDeletedAfter("questionGroup", incoming.id, incoming.updatedAt, incoming.deviceId, event.id)) {
            await clearOlderTombstone("questionGroup", incoming.id, incoming.updatedAt, incoming.deviceId, event.id);
            const items = [];
            for (const item of incoming.items) if (await db.questions.get(item.questionId)) items.push(item);
            const current = await db.questionGroups.get(incoming.id);
            if (items.length && (!current || compareClock(incoming.updatedAt, incoming.deviceId, event.id, current.updatedAt, current.deviceId, current.syncEventId) > 0)) await db.questionGroups.put({ ...incoming, items });
          }
        } else if (event.type === "questionGroup.deleted") {
          const payload = event.payload as { id: string; deletedAt?: string };
          const deletedAt = payload.deletedAt ?? event.createdAt;
          const current = await db.questionGroups.get(payload.id);
          if (!current || compareClock(deletedAt, event.deviceId, event.id, current.updatedAt, current.deviceId, current.syncEventId) >= 0) {
            await putTombstone("questionGroup", payload.id, deletedAt, event.deviceId, event.id);
            await db.questionGroups.delete(payload.id);
          }
        } else if (event.type === "question.created" || event.type === "question.updated") {
          const rawIncoming = { ...(event.payload as Question), syncEventId: event.id };
          const current = await db.questions.get(rawIncoming.id);
          const incoming = await normalizeRemoteQuestionSortOrder(rawIncoming, current);
          const changedAt = incoming.userUpdatedAt ?? event.createdAt;
          if (await db.banks.get(incoming.bankId) && !await isDeletedAfter("question", incoming.id, changedAt, incoming.userUpdatedBy ?? event.deviceId, event.id)) {
            await clearOlderTombstone("question", incoming.id, changedAt, incoming.userUpdatedBy ?? event.deviceId, event.id);
            if (!current || compareClock(changedAt, incoming.userUpdatedBy ?? event.deviceId, event.id, current.userUpdatedAt, current.userUpdatedBy, current.syncEventId) > 0) {
              await db.questions.put(incoming);
              await refreshBankQuestionCount(incoming.bankId);
            }
          }
        } else if (event.type === "question.deleted") {
          const payload = event.payload as { id: string; deletedAt?: string };
          const deletedAt = payload.deletedAt ?? event.createdAt;
          const question = await db.questions.get(payload.id);
          if (!question || compareClock(deletedAt, event.deviceId, event.id, question.userUpdatedAt, question.userUpdatedBy, question.syncEventId) >= 0) {
            await putTombstone("question", payload.id, deletedAt, event.deviceId, event.id);
            await deleteQuestionLocal(payload.id);
            if (question) await refreshBankQuestionCount(question.bankId);
          }
        }
        await db.events.put({ ...event, synced: 1 });
        if (Number.isSafeInteger(event.sequence) && event.sequence >= 0) {
          const key = `cursor:${event.deviceId}`;
          const current = await db.syncMeta.get(key);
          if ((Number(current?.value) || 0) < event.sequence) await db.syncMeta.put({ key, value: event.sequence, updatedAt: event.createdAt });
        }
      }
    },
  );
}
