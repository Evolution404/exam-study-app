import Dexie, { type EntityTable } from "dexie";
import type {
  Attempt,
  Bank,
  BankFolder,
  Note,
  PracticeRun,
  PracticeSession,
  Question,
  QuestionGroup,
  SyncEvent,
  SyncFile,
  SyncSnapshotV2,
  SyncTombstone,
} from "./types";

class StudyDatabase extends Dexie {
  banks!: EntityTable<Bank, "id">;
  bankFolders!: EntityTable<BankFolder, "id">;
  questions!: EntityTable<Question, "id">;
  attempts!: EntityTable<Attempt, "id">;
  notes!: EntityTable<Note, "questionId">;
  practiceRuns!: EntityTable<PracticeRun, "id">;
  questionGroups!: EntityTable<QuestionGroup, "id">;
  events!: EntityTable<SyncEvent, "id">;
  syncFiles!: EntityTable<SyncFile, "path">;
  tombstones!: EntityTable<SyncTombstone, "key">;
  sessions!: EntityTable<PracticeSession, "id">;

  constructor() {
    super("memory-line-study");
    this.version(6).stores({
      banks: "id, folderId, sortOrder, importedAt, updatedAt",
      bankFolders: "id, sortOrder, updatedAt",
      questions: "id, bankId, type, *tags, normalizedStem",
      attempts: "id, questionId, bankId, runId, correct, createdAt, deviceId",
      notes: "questionId, updatedAt",
      practiceRuns: "id, status, startedAt, updatedAt",
      questionGroups: "id, type, updatedAt",
      events: "id, synced, createdAt, deviceId",
      syncFiles: "path, sha, appliedAt",
      tombstones: "key, entityType, entityId, deletedAt",
      sessions: "id, bankId, updatedAt",
    });
  }
}

export const db = new StudyDatabase();

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

  for (const item of source) {
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
  const mergedQuestions = questions.map((question, index) => existingQuestions[index]?.userUpdatedAt ? existingQuestions[index]! : question);

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

async function putSyncEvent(type: SyncEvent["type"], payload: unknown, createdAt = new Date().toISOString()) {
  await db.events.put({ id: makeId("evt"), type, payload, deviceId: getDeviceId(), createdAt, synced: 0 });
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
    await db.questions.where("bankId").equals(bankId).modify({ bankName: bankTitle(bank) });
    await putSyncEvent("bank.updated", bank, now);
  });
  return bank;
}

export async function reorderBanks(bankIds: string[], folderId?: string) {
  const banks = (await db.banks.bulkGet(bankIds)).filter((bank): bank is Bank => Boolean(bank));
  await Promise.all(banks.map((bank, index) => saveBank(bank.id, { displayName: bank.displayName, description: bank.description, color: bank.color, folderId, sortOrder: index })));
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
    await db.events.put({ id: eventId, type: "bankFolder.deleted", payload: { id: folderId, deletedAt: now }, deviceId, createdAt: now, synced: 0 });
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
  const question: Question = { id: makeId("question"), bankId, bankName: bankTitle(bank), stem, normalizedStem: normalizeStem(stem), answer, options, type: changes.type, tags: [...new Set(changes.tags.map((tag) => tag.trim()).filter(Boolean))], userUpdatedAt: now, userUpdatedBy: getDeviceId() };
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
  await db.transaction("rw", db.questions, db.attempts, db.notes, db.questionGroups, db.banks, db.events, db.tombstones, async () => {
    await deleteQuestionLocal(questionId);
    if (bank) { const updated = { ...bank, questionCount: Math.max(0, bank.questionCount - 1), updatedAt: now, deviceId: getDeviceId() }; await db.banks.put(updated); await putSyncEvent("bank.updated", updated, now); }
    await putTombstone("question", questionId, now, deviceId, eventId);
    await db.events.put({ id: eventId, type: "question.deleted", payload: { id: questionId, deletedAt: now }, deviceId, createdAt: now, synced: 0 });
  });
}

async function deleteBankLocal(bankId: string) {
  const questionIds = (await db.questions.where("bankId").equals(bankId).primaryKeys()) as string[];
  await db.questions.where("bankId").equals(bankId).delete();
  await db.attempts.where("bankId").equals(bankId).delete();
  await db.notes.bulkDelete(questionIds);
  const groups = await db.questionGroups.filter((group) => group.items.some((item) => questionIds.includes(item.questionId))).toArray();
  for (const group of groups) {
    const items = group.items.filter((item) => !questionIds.includes(item.questionId));
    if (items.length) await db.questionGroups.put({ ...group, items, updatedAt: new Date().toISOString() }); else await db.questionGroups.delete(group.id);
  }
  const affectedRuns = await db.practiceRuns.filter((run) => run.bankId === bankId || run.bankIds.includes(bankId)).primaryKeys();
  await db.practiceRuns.bulkDelete(affectedRuns as string[]);
  const active = await db.sessions.get("active");
  if (active?.bankIds?.includes(bankId) || active?.bankId === bankId) await db.sessions.delete("active");
  await db.banks.delete(bankId);
}

export async function deleteBank(bankId: string) {
  const now = new Date().toISOString();
  const deviceId = getDeviceId();
  const eventId = makeId("bank-delete");
  await db.transaction("rw", db.banks, db.questions, db.attempts, db.notes, db.questionGroups, db.practiceRuns, db.sessions, db.events, db.tombstones, async () => {
    await deleteBankLocal(bankId);
    await putTombstone("bank", bankId, now, deviceId, eventId);
    await db.events.put({ id: eventId, type: "bank.deleted", payload: { id: bankId, deletedAt: now }, deviceId, createdAt: now, synced: 0 });
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
    createdAt: attempt.createdAt,
    synced: 0,
  };
  await db.transaction("rw", db.attempts, db.events, async () => {
    await db.attempts.put(attempt);
    await db.events.put(event);
  });
  return attempt;
}

export async function saveNote(questionId: string, content: string) {
  const old = await db.notes.get(questionId);
  const note: Note = {
    questionId,
    content,
    revision: (old?.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    deviceId: getDeviceId(),
  };
  await db.transaction("rw", db.notes, db.events, async () => {
    await db.notes.put(note);
    await db.events.put({
      id: makeId("evt"), type: "note.upserted", payload: note,
      deviceId: note.deviceId, createdAt: note.updatedAt, synced: 0,
    });
  });
  return note;
}

export async function savePracticeSession(session: PracticeSession) {
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
  await db.transaction("rw", db.sessions, db.practiceRuns, db.events, async () => {
    const current = await db.sessions.get(session.id);
    if (!current || session.runId !== current.runId || session.revision >= current.revision) await db.sessions.put(session);
    const existingRun = await db.practiceRuns.get(run.id);
    if (!existingRun || run.revision >= existingRun.revision) await db.practiceRuns.put({ ...existingRun, ...run });
    const pending = await db.events.where("synced").equals(0).filter((event) => event.type === "practice.run.saved" && (event.payload as PracticeRun).id === run.id).first();
    await db.events.put({
      id: pending?.id ?? makeId("run"), type: "practice.run.saved", payload: { ...existingRun, ...run },
      deviceId: getDeviceId(), createdAt: run.updatedAt, synced: 0,
    });
  });
  return session;
}

export async function setPracticeRunStatus(runId: string, status: PracticeRun["status"], answers?: PracticeRun["answers"]) {
  const current = await db.practiceRuns.get(runId);
  if (!current) return;
  const now = new Date().toISOString();
  const run: PracticeRun = {
    ...current,
    answers: answers ?? current.answers,
    status,
    updatedAt: now,
    completedAt: status === "completed" ? now : current.completedAt,
    abandonedAt: status === "abandoned" ? now : undefined,
    revision: current.revision + 1,
  };
  await db.transaction("rw", db.practiceRuns, db.events, async () => {
    await db.practiceRuns.put(run);
    const pending = await db.events.where("synced").equals(0).filter((event) => event.type === "practice.run.saved" && (event.payload as PracticeRun).id === run.id).first();
    await db.events.put({ id: pending?.id ?? makeId("run"), type: "practice.run.saved", payload: run, deviceId: getDeviceId(), createdAt: now, synced: 0 });
  });
  return run;
}

export async function deletePracticeRun(runId: string) {
  const current = await db.practiceRuns.get(runId);
  if (!current) return false;
  const now = new Date().toISOString();
  const deviceId = getDeviceId();
  const eventId = makeId("run-delete");
  await db.transaction("rw", db.practiceRuns, db.sessions, db.events, db.tombstones, async () => {
    const active = await db.sessions.get("active");
    if (active?.runId === runId) await db.sessions.delete("active");
    await db.practiceRuns.delete(runId);
    const pendingSaves = await db.events.where("synced").equals(0).filter((event) => event.type === "practice.run.saved" && (event.payload as PracticeRun).id === runId).toArray();
    if (pendingSaves.length) await db.events.bulkDelete(pendingSaves.map((event) => event.id));
    await putTombstone("practiceRun", runId, now, deviceId, eventId);
    await db.events.put({ id: eventId, type: "practice.run.deleted", payload: { id: runId, deletedAt: now }, deviceId, createdAt: now, synced: 0 });
  });
  return true;
}

export async function clearPracticeSession() {
  await db.sessions.delete("active");
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
  const event: SyncEvent = {
    id: makeId("question"),
    type: "question.updated",
    payload: question,
    deviceId: question.userUpdatedBy,
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
  const event: SyncEvent = {
    id: makeId("question"),
    type: "question.updated",
    payload: question,
    deviceId: question.userUpdatedBy,
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

export function validateSyncSnapshot(snapshot: unknown): asserts snapshot is SyncSnapshotV2 {
  if (!snapshot || typeof snapshot !== "object" || (snapshot as SyncSnapshotV2).formatVersion !== 2) {
    throw new Error("远程快照格式无效或版本不受支持。");
  }
  const value = snapshot as SyncSnapshotV2;
  const state = value.state;
  if (!state || !validSnapshotArray(state.banks) || !validSnapshotArray(state.bankFolders)
    || !validSnapshotArray(state.questions) || !validSnapshotArray(state.attempts)
    || !validSnapshotArray(state.notes) || !validSnapshotArray(state.practiceRuns)
    || !validSnapshotArray(state.questionGroups) || !validSnapshotArray(state.tombstones)) {
    throw new Error("远程快照缺少必要的数据集合。");
  }
  const expectedCounts = {
    banks: state.banks.length, bankFolders: state.bankFolders.length, questions: state.questions.length,
    attempts: state.attempts.length, notes: state.notes.length, practiceRuns: state.practiceRuns.length,
    questionGroups: state.questionGroups.length, tombstones: state.tombstones.length,
  };
  if (!value.counts || Object.entries(expectedCounts).some(([key, count]) => value.counts[key as keyof typeof value.counts] !== count)) {
    throw new Error("远程快照统计与实际内容不一致。");
  }
  const allowedBanks = state.banks.every((bank) => bank?.id && /^送电线路工-(初级工|中级工|高级工|技师)$/.test(bank.name));
  if (!allowedBanks) throw new Error("远程快照包含不受支持的题库。");
  const bankIds = new Set(state.banks.map((bank) => bank.id));
  const questionIds = new Set(state.questions.map((question) => question.id));
  if (state.questions.some((question) => !question?.id || !bankIds.has(question.bankId))) throw new Error("远程快照中的题目引用了不存在的题库。");
  if (state.attempts.some((attempt) => !attempt?.id || !questionIds.has(attempt.questionId))) throw new Error("远程快照中的作答记录引用了不存在的题目。");
  if (state.notes.some((note) => !note?.questionId || !questionIds.has(note.questionId))) throw new Error("远程快照中的解析引用了不存在的题目。");
}

export async function createSyncSnapshot(): Promise<SyncSnapshotV2> {
  const [banks, bankFolders, questions, attempts, notes, practiceRuns, questionGroups, tombstones] = await Promise.all([
    db.banks.toArray(), db.bankFolders.toArray(), db.questions.toArray(), db.attempts.toArray(),
    db.notes.toArray(), db.practiceRuns.toArray(), db.questionGroups.toArray(), db.tombstones.toArray(),
  ]);
  return {
    formatVersion: 2,
    generatedAt: new Date().toISOString(),
    state: { banks, bankFolders, questions, attempts, notes, practiceRuns, questionGroups, tombstones },
    counts: {
      banks: banks.length, bankFolders: bankFolders.length, questions: questions.length, attempts: attempts.length, notes: notes.length,
      practiceRuns: practiceRuns.length, questionGroups: questionGroups.length, tombstones: tombstones.length,
    },
  };
}

function practiceRunWins(incoming: PracticeRun, current: PracticeRun | undefined, deviceId = "", tie = "") {
  if (!current) return true;
  if (incoming.revision !== current.revision) return incoming.revision > current.revision;
  return compareClock(incoming.updatedAt, incoming.syncDeviceId ?? deviceId, incoming.syncEventId ?? tie, current.updatedAt, current.syncDeviceId, current.syncEventId) > 0;
}

export async function applySyncSnapshot(snapshot: SyncSnapshotV2, replace = false) {
  validateSyncSnapshot(snapshot);
  await db.transaction(
    "rw",
    db.banks, db.bankFolders, db.questions, db.attempts, db.notes, db.practiceRuns,
    db.questionGroups, db.tombstones, db.sessions, db.events, db.syncFiles,
    async () => {
      if (replace) {
        await Promise.all([
          db.banks.clear(), db.bankFolders.clear(), db.questions.clear(), db.attempts.clear(), db.notes.clear(),
          db.practiceRuns.clear(), db.questionGroups.clear(), db.tombstones.clear(), db.sessions.clear(),
          db.events.clear(), db.syncFiles.clear(),
        ]);
        const questionIds = new Set(snapshot.state.questions.map((question) => question.id));
        const questionGroups = snapshot.state.questionGroups
          .map((group) => ({ ...group, items: group.items.filter((item) => questionIds.has(item.questionId)) }))
          .filter((group) => group.items.length);
        await Promise.all([
          db.banks.bulkPut(snapshot.state.banks),
          db.bankFolders.bulkPut(snapshot.state.bankFolders),
          db.questions.bulkPut(snapshot.state.questions),
          db.attempts.bulkPut(snapshot.state.attempts),
          db.notes.bulkPut(snapshot.state.notes),
          db.practiceRuns.bulkPut(snapshot.state.practiceRuns),
          db.questionGroups.bulkPut(questionGroups),
          db.tombstones.bulkPut(snapshot.state.tombstones),
        ]);
        return;
      }
      for (const tombstone of snapshot.state.tombstones) {
        await putTombstone(tombstone.entityType, tombstone.entityId, tombstone.deletedAt, tombstone.deviceId, tombstone.eventId);
      }
      for (const tombstone of await db.tombstones.toArray()) {
        if (tombstone.entityType === "bank") await deleteBankLocal(tombstone.entityId);
        else if (tombstone.entityType === "bankFolder") {
          await db.bankFolders.delete(tombstone.entityId);
          await db.banks.where("folderId").equals(tombstone.entityId).modify({ folderId: undefined });
        } else if (tombstone.entityType === "question") await deleteQuestionLocal(tombstone.entityId);
        else if (tombstone.entityType === "practiceRun") await db.practiceRuns.delete(tombstone.entityId);
        else if (tombstone.entityType === "questionGroup") await db.questionGroups.delete(tombstone.entityId);
      }
      for (const incoming of snapshot.state.banks) {
        const changedAt = incoming.updatedAt ?? incoming.importedAt;
        if (await isDeletedAfter("bank", incoming.id, changedAt, incoming.deviceId)) continue;
        const current = await db.banks.get(incoming.id);
        if (!current || compareClock(changedAt, incoming.deviceId, incoming.syncEventId, current.updatedAt ?? current.importedAt, current.deviceId, current.syncEventId) > 0) await db.banks.put(incoming);
      }
      for (const incoming of snapshot.state.bankFolders) {
        if (await isDeletedAfter("bankFolder", incoming.id, incoming.updatedAt, incoming.deviceId)) continue;
        const current = await db.bankFolders.get(incoming.id);
        if (!current || compareClock(incoming.updatedAt, incoming.deviceId, incoming.syncEventId, current.updatedAt, current.deviceId, current.syncEventId) > 0) await db.bankFolders.put(incoming);
      }
      for (const incoming of snapshot.state.questions) {
        const changedAt = incoming.userUpdatedAt ?? "";
        if (await isDeletedAfter("question", incoming.id, changedAt, incoming.userUpdatedBy)) continue;
        if (!await db.banks.get(incoming.bankId)) continue;
        const current = await db.questions.get(incoming.id);
        if (!current || compareClock(changedAt, incoming.userUpdatedBy, incoming.syncEventId, current.userUpdatedAt, current.userUpdatedBy, current.syncEventId) > 0) await db.questions.put(incoming);
      }
      for (const attempt of snapshot.state.attempts) if (await db.questions.get(attempt.questionId)) await db.attempts.put(attempt);
      for (const incoming of snapshot.state.notes) {
        const current = await db.notes.get(incoming.questionId);
        if (!current || compareClock(incoming.updatedAt, incoming.deviceId, incoming.syncEventId, current.updatedAt, current.deviceId, current.syncEventId) > 0) await db.notes.put(incoming);
      }
      for (const incoming of snapshot.state.practiceRuns) {
        if (await isDeletedAfter("practiceRun", incoming.id, incoming.updatedAt)) continue;
        if (practiceRunWins(incoming, await db.practiceRuns.get(incoming.id), "snapshot", incoming.syncEventId)) await db.practiceRuns.put(incoming);
      }
      for (const incoming of snapshot.state.questionGroups) {
        if (await isDeletedAfter("questionGroup", incoming.id, incoming.updatedAt, incoming.deviceId)) continue;
        const items = incoming.items.filter((item) => snapshot.state.questions.some((question) => question.id === item.questionId));
        const current = await db.questionGroups.get(incoming.id);
        if (items.length && (!current || compareClock(incoming.updatedAt, incoming.deviceId, incoming.syncEventId, current.updatedAt, current.deviceId, current.syncEventId) > 0)) await db.questionGroups.put({ ...incoming, items });
      }
    },
  );
}

export async function applyRemoteEvents(events: SyncEvent[]) {
  const ordered = [...events].sort((a, b) => compareClock(a.createdAt, a.deviceId, a.id, b.createdAt, b.deviceId, b.id));
  await db.transaction(
    "rw",
    db.banks, db.bankFolders, db.questions, db.attempts, db.notes, db.practiceRuns,
    db.questionGroups, db.sessions, db.events, db.tombstones,
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
            for (const remoteQuestion of payload.questions) {
              const incoming: Question = remoteQuestion.userUpdatedAt ? { ...remoteQuestion, syncEventId: event.id } : { ...remoteQuestion, bankName: bankTitle(bank), tags: [], syncEventId: event.id };
              if (await isDeletedAfter("question", incoming.id, incoming.userUpdatedAt ?? event.createdAt, incoming.userUpdatedBy ?? event.deviceId, event.id)) continue;
              const current = await db.questions.get(incoming.id);
              merged.push(current?.userUpdatedAt ? current : incoming);
            }
            if (merged.length) await db.questions.bulkPut(merged);
          }
        } else if (event.type === "bank.updated") {
          const incoming = { ...(event.payload as Bank), syncEventId: event.id };
          const changedAt = incoming.updatedAt ?? event.createdAt;
          if (!await isDeletedAfter("bank", incoming.id, changedAt, incoming.deviceId ?? event.deviceId, event.id)) {
            await clearOlderTombstone("bank", incoming.id, changedAt, incoming.deviceId ?? event.deviceId, event.id);
            const current = await db.banks.get(incoming.id);
            if (!current || compareClock(changedAt, incoming.deviceId ?? event.deviceId, event.id, current.updatedAt ?? current.importedAt, current.deviceId, current.syncEventId) > 0) {
              await db.banks.put(incoming);
              await db.questions.where("bankId").equals(incoming.id).modify({ bankName: bankTitle(incoming) });
            }
          }
        } else if (event.type === "bank.deleted") {
          const payload = event.payload as { id: string; deletedAt?: string };
          await putTombstone("bank", payload.id, payload.deletedAt ?? event.createdAt, event.deviceId, event.id);
          await deleteBankLocal(payload.id);
        } else if (event.type === "bankFolder.saved") {
          const incoming = { ...(event.payload as BankFolder), syncEventId: event.id };
          if (!await isDeletedAfter("bankFolder", incoming.id, incoming.updatedAt, incoming.deviceId, event.id)) {
            await clearOlderTombstone("bankFolder", incoming.id, incoming.updatedAt, incoming.deviceId, event.id);
            const current = await db.bankFolders.get(incoming.id);
            if (!current || compareClock(incoming.updatedAt, incoming.deviceId, event.id, current.updatedAt, current.deviceId, current.syncEventId) > 0) await db.bankFolders.put(incoming);
          }
        } else if (event.type === "bankFolder.deleted") {
          const payload = event.payload as { id: string; deletedAt?: string };
          await putTombstone("bankFolder", payload.id, payload.deletedAt ?? event.createdAt, event.deviceId, event.id);
          await db.bankFolders.delete(payload.id);
          await db.banks.where("folderId").equals(payload.id).modify({ folderId: undefined });
        } else if (event.type === "attempt.created") {
          const incoming = event.payload as Attempt;
          if (incoming?.id && await db.questions.get(incoming.questionId)) await db.attempts.put(incoming);
        } else if (event.type === "note.upserted") {
          const incoming = { ...(event.payload as Note), syncEventId: event.id };
          const current = await db.notes.get(incoming.questionId);
          if (!current || compareClock(incoming.updatedAt, incoming.deviceId, event.id, current.updatedAt, current.deviceId, current.syncEventId) > 0) await db.notes.put(incoming);
        } else if (event.type === "practice.run.saved") {
          const incoming = { ...(event.payload as PracticeRun), syncDeviceId: event.deviceId, syncEventId: event.id };
          if (!await isDeletedAfter("practiceRun", incoming.id, incoming.updatedAt, event.deviceId, event.id)) {
            await clearOlderTombstone("practiceRun", incoming.id, incoming.updatedAt, event.deviceId, event.id);
            if (practiceRunWins(incoming, await db.practiceRuns.get(incoming.id), event.deviceId, event.id)) await db.practiceRuns.put(incoming);
          }
        } else if (event.type === "practice.run.deleted") {
          const payload = event.payload as { id: string; deletedAt?: string };
          await putTombstone("practiceRun", payload.id, payload.deletedAt ?? event.createdAt, event.deviceId, event.id);
          const active = await db.sessions.get("active");
          if (active?.runId === payload.id) await db.sessions.delete("active");
          await db.practiceRuns.delete(payload.id);
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
          await putTombstone("questionGroup", payload.id, payload.deletedAt ?? event.createdAt, event.deviceId, event.id);
          await db.questionGroups.delete(payload.id);
        } else if (event.type === "question.created" || event.type === "question.updated") {
          const incoming = { ...(event.payload as Question), syncEventId: event.id };
          const changedAt = incoming.userUpdatedAt ?? event.createdAt;
          if (await db.banks.get(incoming.bankId) && !await isDeletedAfter("question", incoming.id, changedAt, incoming.userUpdatedBy ?? event.deviceId, event.id)) {
            await clearOlderTombstone("question", incoming.id, changedAt, incoming.userUpdatedBy ?? event.deviceId, event.id);
            const current = await db.questions.get(incoming.id);
            if (!current || compareClock(changedAt, incoming.userUpdatedBy ?? event.deviceId, event.id, current.userUpdatedAt, current.userUpdatedBy, current.syncEventId) > 0) await db.questions.put(incoming);
          }
        } else if (event.type === "question.deleted") {
          const payload = event.payload as { id: string; deletedAt?: string };
          await putTombstone("question", payload.id, payload.deletedAt ?? event.createdAt, event.deviceId, event.id);
          await deleteQuestionLocal(payload.id);
        }
        await db.events.put({ ...event, synced: 1 });
      }
    },
  );
}
