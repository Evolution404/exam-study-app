import Dexie, { type EntityTable } from "dexie";
import type {
  Attempt,
  Bank,
  Note,
  Question,
  Relation,
  SyncEvent,
  SyncFile,
} from "./types";

class StudyDatabase extends Dexie {
  banks!: EntityTable<Bank, "id">;
  questions!: EntityTable<Question, "id">;
  attempts!: EntityTable<Attempt, "id">;
  notes!: EntityTable<Note, "questionId">;
  relations!: EntityTable<Relation, "id">;
  events!: EntityTable<SyncEvent, "id">;
  syncFiles!: EntityTable<SyncFile, "path">;

  constructor() {
    super("memory-line-study");
    this.version(1).stores({
      banks: "id, importedAt",
      questions: "id, bankId, type, *tags, normalizedStem",
      attempts: "id, questionId, bankId, correct, createdAt, deviceId",
      notes: "questionId, updatedAt",
      relations: "id, fromQuestionId, toQuestionId, type",
      events: "id, synced, createdAt, deviceId",
      syncFiles: "path, sha, appliedAt",
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

function inferTags(stem: string) {
  const dictionary = [
    "弧垂", "导线", "杆塔", "接地", "绝缘子", "安全", "工作票", "测量",
    "基础", "混凝土", "巡视", "缺陷", "雷电", "无人机", "跨越", "电压",
  ];
  return dictionary.filter((tag) => stem.includes(tag));
}

export async function importQuestionBank(fileName: string, raw: unknown) {
  const source = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw && Array.isArray((raw as { questions?: unknown[] }).questions)
      ? (raw as { questions: unknown[] }).questions
      : null;
  if (!source) throw new Error("未找到题目数组。支持数组或 { questions: [] } 格式。");

  const bankName = fileName.replace(/\.(json|txt)$/i, "");
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
      tags: inferTags(stem),
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

export async function applyRemoteEvents(events: SyncEvent[]) {
  await db.transaction(
    "rw",
    db.banks,
    db.questions,
    db.attempts,
    db.notes,
    db.relations,
    db.events,
    async () => {
      for (const event of events) {
        if (await db.events.get(event.id)) continue;
        if (event.type === "bank.imported") {
          const payload = event.payload as { bank: Bank; questions: Question[] };
          await db.banks.put(payload.bank);
          await db.questions.bulkPut(payload.questions);
        } else if (event.type === "attempt.created") {
          await db.attempts.put(event.payload as Attempt);
        } else if (event.type === "note.upserted") {
          const incoming = event.payload as Note;
          const current = await db.notes.get(incoming.questionId);
          if (!current || incoming.updatedAt > current.updatedAt) await db.notes.put(incoming);
        } else if (event.type === "relation.created") {
          await db.relations.put(event.payload as Relation);
        }
        await db.events.put({ ...event, synced: 1 });
      }
    },
  );
}
