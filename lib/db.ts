import Dexie, { type EntityTable } from "dexie";
import type {
  Attempt,
  Bank,
  Note,
  PracticeRun,
  PracticeSession,
  Question,
  QuestionGroup,
  SyncEvent,
  SyncFile,
} from "./types";

class StudyDatabase extends Dexie {
  banks!: EntityTable<Bank, "id">;
  questions!: EntityTable<Question, "id">;
  attempts!: EntityTable<Attempt, "id">;
  notes!: EntityTable<Note, "questionId">;
  practiceRuns!: EntityTable<PracticeRun, "id">;
  questionGroups!: EntityTable<QuestionGroup, "id">;
  events!: EntityTable<SyncEvent, "id">;
  syncFiles!: EntityTable<SyncFile, "path">;
  sessions!: EntityTable<PracticeSession, "id">;

  constructor() {
    super("memory-line-study");
    this.version(1).stores({
      banks: "id, importedAt",
      questions: "id, bankId, type, *tags, normalizedStem",
      attempts: "id, questionId, bankId, runId, correct, createdAt, deviceId",
      notes: "questionId, updatedAt",
      practiceRuns: "id, status, startedAt, updatedAt",
      questionGroups: "id, type, updatedAt",
      events: "id, synced, createdAt, deviceId",
      syncFiles: "path, sha, appliedAt",
    });
    this.version(2).stores({
      sessions: "id, bankId, updatedAt",
    });
    this.version(3).stores({
      banks: "id, importedAt",
      questions: "id, bankId, type, *tags, normalizedStem",
      attempts: "id, questionId, bankId, runId, correct, createdAt, deviceId",
      notes: "questionId, updatedAt",
      practiceRuns: "id, status, startedAt, updatedAt",
      questionGroups: "id, type, updatedAt",
      events: "id, synced, createdAt, deviceId",
      syncFiles: "path, sha, appliedAt",
      sessions: "id, bankId, updatedAt",
    }).upgrade(async (transaction) => {
      const bankEvents = (await transaction.table<SyncEvent>("events").toArray())
        .filter((event) => event.type === "bank.imported")
        .map((event) => ({ ...event, synced: 1 as const }));
      await Promise.all([
        transaction.table("attempts").clear(),
        transaction.table("notes").clear(),
        transaction.table("practiceRuns").clear(),
        transaction.table("questionGroups").clear(),
        transaction.table("sessions").clear(),
        transaction.table("events").clear(),
      ]);
      if (bankEvents.length) await transaction.table("events").bulkPut(bankEvents);
      await transaction.table<Question>("questions").toCollection().modify((question) => {
        question.tags = [];
        question.favorite = false;
        delete question.userUpdatedAt;
        delete question.userUpdatedBy;
      });
    });
    this.version(4).stores({
      banks: "id, importedAt",
      questions: "id, bankId, type, *tags, normalizedStem",
      attempts: "id, questionId, bankId, runId, correct, createdAt, deviceId",
      notes: "questionId, updatedAt",
      practiceRuns: "id, status, startedAt, updatedAt",
      questionGroups: "id, type, updatedAt",
      events: "id, synced, createdAt, deviceId",
      syncFiles: "path, sha, appliedAt",
      sessions: "id, bankId, updatedAt",
    }).upgrade(async (transaction) => {
      const allowedName = (name: string) => /^送电线路工-(初级工|中级工|高级工|技师)$/.test(name);
      const banks = await transaction.table<Bank>("banks").toArray();
      const allowedBankIds = new Set(banks.filter((bank) => allowedName(bank.name)).map((bank) => bank.id));
      await transaction.table<Question>("questions").filter((question) => !allowedBankIds.has(question.bankId)).delete();
      await transaction.table<Bank>("banks").filter((bank) => !allowedBankIds.has(bank.id)).delete();
      const bankEvents = (await transaction.table<SyncEvent>("events").toArray()).filter((event) => {
        if (event.type !== "bank.imported") return false;
        return allowedName((event.payload as { bank?: Bank }).bank?.name ?? "");
      }).map((event) => ({ ...event, synced: 1 as const }));
      await Promise.all([
        transaction.table("attempts").clear(), transaction.table("notes").clear(),
        transaction.table("practiceRuns").clear(), transaction.table("questionGroups").clear(),
        transaction.table("sessions").clear(), transaction.table("events").clear(),
      ]);
      if (bankEvents.length) await transaction.table("events").bulkPut(bankEvents);
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
      bankName,
      stem,
      normalizedStem,
      answer: answer.toUpperCase().replace(/[^A-Z]/g, ""),
      options,
      type,
      tags: [],
    });
  }
  if (!questions.length) throw new Error("题库中没有可导入的有效题目。");

  const bank: Bank = {
    id: bankId,
    name: bankName,
    questionCount: questions.length,
    importedAt: new Date().toISOString(),
  };
  const deviceId = getDeviceId();
  const event: SyncEvent = {
    id: makeId("bank"),
    type: "bank.imported",
    payload: { bank, questions },
    deviceId,
    createdAt: new Date().toISOString(),
    synced: 0,
  };
  await db.transaction("rw", db.banks, db.questions, db.events, async () => {
    await db.banks.put(bank);
    await db.questions.bulkPut(questions);
    await db.events.put(event);
  });
  return bank;
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

export async function clearPracticeSession() {
  await db.sessions.delete("active");
}

export async function clearLegacyGeneratedTags() {
  const legacy = await db.questions.filter((question) => !question.userUpdatedAt && question.tags.length > 0).toArray();
  if (legacy.length) await db.questions.bulkPut(legacy.map((question) => ({ ...question, tags: [] })));
  return legacy.length;
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
  const event: SyncEvent = {
    id: makeId("evt"),
    type: "questionGroup.deleted",
    payload: { id: groupId },
    deviceId: getDeviceId(),
    createdAt,
    synced: 0,
  };
  await db.transaction("rw", db.questionGroups, db.events, async () => {
    await db.questionGroups.delete(groupId);
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

export async function applyRemoteEvents(events: SyncEvent[]) {
  await db.transaction(
    "rw",
    db.banks,
    db.questions,
    db.attempts,
    db.notes,
    db.practiceRuns,
    db.questionGroups,
    db.events,
    async () => {
      for (const event of events) {
        if (await db.events.get(event.id)) continue;
        if (event.type === "bank.imported") {
          const payload = event.payload as { bank: Bank; questions: Question[] };
          if (!/^送电线路工-(初级工|中级工|高级工|技师)$/.test(payload.bank.name)) {
            await db.events.put({ ...event, synced: 1 });
            continue;
          }
          await db.banks.put(payload.bank);
          const merged: Question[] = [];
          for (const remoteQuestion of payload.questions) {
            const incoming = remoteQuestion.userUpdatedAt ? remoteQuestion : { ...remoteQuestion, tags: [] };
            const current = await db.questions.get(incoming.id);
            merged.push(current?.userUpdatedAt ? current : incoming);
          }
          await db.questions.bulkPut(merged);
        } else if (event.type === "attempt.created") {
          const incoming = event.payload as Attempt;
          if (await db.questions.get(incoming.questionId)) await db.attempts.put(incoming);
        } else if (event.type === "note.upserted") {
          const incoming = event.payload as Note;
          const current = await db.notes.get(incoming.questionId);
          if (!current || incoming.updatedAt > current.updatedAt) await db.notes.put(incoming);
        } else if (event.type === "practice.run.saved") {
          const incoming = event.payload as PracticeRun;
          const current = await db.practiceRuns.get(incoming.id);
          if (!current || incoming.revision >= current.revision) await db.practiceRuns.put(incoming);
        } else if (event.type === "questionGroup.saved") {
          const incoming = event.payload as QuestionGroup;
          const items = [];
          for (const item of incoming.items) if (await db.questions.get(item.questionId)) items.push(item);
          if (items.length) {
            const current = await db.questionGroups.get(incoming.id);
            if (!current || incoming.updatedAt >= current.updatedAt) await db.questionGroups.put({ ...incoming, items });
          }
        } else if (event.type === "questionGroup.deleted") {
          await db.questionGroups.delete((event.payload as { id: string }).id);
        } else if (event.type === "question.updated") {
          const incoming = event.payload as Question;
          const current = await db.questions.get(incoming.id);
          if (!current?.userUpdatedAt || (incoming.userUpdatedAt ?? event.createdAt) > current.userUpdatedAt) {
            await db.questions.put(incoming);
          }
        }
        await db.events.put({ ...event, synced: 1 });
      }
    },
  );
}
