/** Semi-trusted question import parsing and atomic bank import. */
import { dbV7, getV7DeviceId, makeV7Id, nowIso, uniqueStrings } from "./db-v7-core";
import { enqueueChangeSetV7 } from "./db-v7-change-sets";
import {
  membershipKey,
  refreshBankQuestionCountInTx,
  saveMembershipInTx,
  sha256Text,
} from "./db-v7-bank";
import {
  blocksFromPlaceholderText,
  deriveContentText,
  normalizeContentText,
  plainTextToContentBlocks,
  stripImagePlaceholders,
} from "../question/question-content";
import {
  findQuestionByFingerprint,
  questionFromDraft,
  type StructuredQuestionDraftV7,
} from "./db-v7-question-draft";
import type {
  BankQuestionMembership,
  BankV7,
  ContentBlock,
  ImageAsset,
  NoteV7,
  QuestionTypeV7,
  QuestionV7,
  QuestionSolution,
} from "./v7-types";

interface ImportedQuestionRowV7 {
  stem: string;
  type?: string;
  options?: unknown;
  answer?: unknown;
  tags?: unknown;
}

function rawQuestionRows(raw: unknown): { name?: string; rows: ImportedQuestionRowV7[] } {
  if (typeof raw === "string") {
    try {
      return rawQuestionRows(JSON.parse(raw) as unknown);
    } catch {
      throw new Error("JSON 题库内容无效。");
    }
  }
  if (Array.isArray(raw)) return { rows: raw as ImportedQuestionRowV7[] };
  if (!raw || typeof raw !== "object") throw new Error("未找到题目数组。支持数组或 { questions: [] } 格式。");
  const record = raw as Record<string, unknown>;
  const questions = record.questions ?? record.items ?? record.data;
  if (!Array.isArray(questions)) throw new Error("未找到题目数组。支持数组或 { questions: [] } 格式。");
  return { name: typeof record.name === "string" ? record.name : undefined, rows: questions as ImportedQuestionRowV7[] };
}

function rowString(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (row[key] === undefined || row[key] === null) continue;
    if (Array.isArray(row[key])) return row[key].join("");
    return String(row[key]);
  }
  return "";
}

function rowOptions(row: Record<string, unknown>): unknown {
  return row.options ?? row.a ?? row.choices ?? row["选项"];
}

const ASSET_ID_PATTERN = /^[0-9a-f]{64}$/;
const PLACEHOLDER_TEST = /【图[0-9]+】/;

/** Sanitise semi-trusted imported blocks: text blocks keep their text, image
 *  blocks must reference a materialised 64-hex asset id.  Anything else is
 *  dropped rather than trusted. */
function importedBlocks(value: unknown): ContentBlock[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const blocks: ContentBlock[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ id: `text-${blocks.length}`, type: "text", text: normalizeContentText(block.text) });
    } else if (block.type === "image" && typeof block.assetId === "string" && ASSET_ID_PATTERN.test(block.assetId)) {
      blocks.push({ id: `image-${blocks.length}`, type: "image", assetId: block.assetId });
    } else return undefined;
  }
  return blocks;
}

function importDraft(row: ImportedQuestionRowV7): StructuredQuestionDraftV7 | undefined {
  if (!row || typeof row !== "object") return undefined;
  const record = row as unknown as Record<string, unknown>;
  const imageIds = Array.isArray(record.images)
    ? record.images.map(String).filter((id) => ASSET_ID_PATTERN.test(id))
    : [];
  // Structured content (zip bundle) wins; otherwise placeholder text (Excel
  // image columns) is split back into blocks, and plain stems stay plain.
  const structuredContent = importedBlocks(record.content);
  const rawStem = normalizeContentText(rowString(record, "stem", "question", "q", "题干"));
  const stem = rawStem || (structuredContent ? deriveContentText(structuredContent) : "");
  if (!stem && !structuredContent?.length) return undefined;
  const content = structuredContent ?? (imageIds.length ? blocksFromPlaceholderText(rawStem, imageIds, "stem") : undefined);
  const cleanStem = content ? undefined : (imageIds.length ? rawStem : stripImagePlaceholders(rawStem));
  const rawOptions = rowOptions(record);
  const blockOptions = Array.isArray(rawOptions) && rawOptions.length > 0 && rawOptions.every((item) => Array.isArray(item))
    ? rawOptions.map((item, index) => importedBlocks(item) ?? plainTextToContentBlocks("", `option-${index}-0`))
    : undefined;
  // Excel image columns ship option text with 【图N】 markers; those options
  // split into block arrays so the images land inside the option itself.
  const placeholderOption = (value: unknown, index: number) => {
    const optionText = String(value ?? "").trim();
    return imageIds.length && PLACEHOLDER_TEST.test(optionText) ? blocksFromPlaceholderText(optionText, imageIds, `option-${index}`) : optionText;
  };
  const options = blockOptions ?? (Array.isArray(rawOptions) ? rawOptions.map(placeholderOption) : []);
  const optionTexts = options.map((option) => typeof option === "string" ? option : deriveContentText(option));
  const rawType = rowString(record, "type", "questionType", "题型").trim();
  const rawAnswer = record.answer ?? record.ans ?? record.correctAnswer ?? record["答案"] ?? "";
  const answer = Array.isArray(rawAnswer)
    ? rawType === "填空" && rawAnswer.every((item) => Array.isArray(item))
      ? rawAnswer.map((item) => (item as unknown[]).map(String).join("||")).join("\n")
      : rawAnswer.map((item) => Array.isArray(item) ? item.map(String).join("||") : String(item)).join(rawType === "计算" || rawType === "填空" ? "\n" : "")
    : String(rawAnswer);
  const type: QuestionTypeV7 = rawType === "判断" || rawType === "单选" || rawType === "多选" || rawType === "计算" || rawType === "填空" || rawType === "简答"
    ? rawType
    : optionTexts.length === 2 && optionTexts[0] === "正确" && optionTexts[1] === "错误"
      ? "判断"
      : answer.replace(/[^A-Z]/gi, "").length > 1 ? "多选" : "单选";
  if (!answer.trim() || (!["计算", "填空", "简答"].includes(type) && options.length < 2)) return undefined;
  const rawTags = record.tags ?? record["标签"];
  const tags = Array.isArray(rawTags) ? rawTags.map(String) : String(rawTags ?? "").split(/[，,、\n]+/);
  const note = rowString(record, "note", "analysis", "解析").trim();
  return {
    type,
    ...(content ? { content } : { stem: cleanStem ?? stem }),
    options,
    answer,
    ...(Array.isArray(record.optionIds) && record.optionIds.length === options.length ? { optionIds: record.optionIds.map(String) } : {}),
    ...(record.solution && typeof record.solution === "object" ? { solution: record.solution as QuestionSolution } : {}),
    tags: uniqueStrings(tags),
    ...(note ? { note } : {}),
  };
}

/**
 * Import a plain JSON question list.  The bank id is deterministic for a
 * filename/name, while question identity is content-addressed globally.  Pass
 * `options.targetBankId` to append into an EXISTING bank instead of deriving
 * one from the file name (dedupe / sortOrder append / note ownership all keep
 * the same semantics).  The import is published as one atomic change-set; when
 * its body exceeds the v7 inline-event budget the sync layer offloads it to a
 * content-addressed immutable object, so imports of any size stay within the
 * protocol limits.
 */
export async function importQuestionBankV7(fileName: string, raw: unknown, options?: { targetBankId?: string; imageAssets?: readonly ImageAsset[] }): Promise<BankV7 & { importedCount: number }> {
  const parsed = rawQuestionRows(raw);
  const rows = parsed.rows.map(importDraft).filter((row): row is StructuredQuestionDraftV7 => Boolean(row));
  if (!rows.length) throw new Error("题库中没有可导入的有效题目。");
  const timestamp = nowIso();
  const deviceId = getV7DeviceId();
  let bank: BankV7;
  if (options?.targetBankId) {
    const existingBank = await dbV7.banks.get(options.targetBankId);
    if (!existingBank) throw new Error("目标题库不存在，可能已被删除，请刷新后重试。");
    bank = { ...existingBank, updatedAt: timestamp, deviceId };
  } else {
    const sourceName = (parsed.name?.trim() || fileName.replace(/\.(json|txt)$/i, "").trim());
    if (!sourceName) throw new Error("题库名称不能为空。");
    const bankId = `bank_${(await sha256Text(sourceName)).slice(0, 48)}`;
    const existingBank = await dbV7.banks.get(bankId);
    bank = existingBank ? {
      ...existingBank,
      name: existingBank.name || sourceName,
      updatedAt: timestamp,
      deviceId,
    } : {
      id: bankId,
      name: sourceName,
      sortOrder: await dbV7.banks.count(),
      questionCount: 0,
      enabled: true,
      importedAt: timestamp,
      updatedAt: timestamp,
      deviceId,
    };
  }
  const seenInImport = new Set<string>();
  const materialised: Array<{ question: QuestionV7; membership: BankQuestionMembership; isNewMembership: boolean }> = [];
  const materialisedNotes: NoteV7[] = [];
  let sortOrder = await dbV7.bankQuestionMemberships.where("bankId").equals(bank.id).count();
  for (const draft of rows) {
    const provisional = questionFromDraft(makeV7Id("question"), draft, timestamp, deviceId);
    const existing = await findQuestionByFingerprint(provisional.contentFingerprint);
    const question = existing ?? provisional;
    if (seenInImport.has(question.id)) continue;
    seenInImport.add(question.id);
    const existingMembership = await dbV7.bankQuestionMemberships.get(membershipKey(bank.id, question.id));
    const membership: BankQuestionMembership = existingMembership ?? {
      key: membershipKey(bank.id, question.id),
      bankId: bank.id,
      questionId: question.id,
      sortOrder: sortOrder++,
      addedAt: timestamp,
      updatedAt: timestamp,
      deviceId,
    };
    materialised.push({ question, membership: { ...membership, updatedAt: timestamp, deviceId }, isNewMembership: !existingMembership });
    // Imported 解析 becomes a personal note only when the question has none yet;
    // an existing note is user-owned and must not be overwritten by re-import.
    if (draft.note?.trim() && !(await dbV7.notes.get(question.id))) {
      materialisedNotes.push({ questionId: question.id, content: draft.note.trim(), revision: 1, updatedAt: timestamp, deviceId });
    }
  }
  const referencedAssetIds = new Set(materialised.flatMap(({ question }) => [...question.content, ...question.options.flat()]
    .filter((block) => block.type === "image")
    .map((block) => block.assetId)));
  const importImages = (options?.imageAssets ?? [])
    .filter((asset) => referencedAssetIds.has(asset.id))
    .map(({ blob: _blob, ...descriptor }) => {
      void _blob;
      return descriptor;
    });
  await dbV7.transaction("rw", [dbV7.banks, dbV7.questions, dbV7.bankQuestionMemberships, dbV7.tombstones, dbV7.changeSets, dbV7.notes, dbV7.syncMeta], async () => {
    await dbV7.banks.put(bank);
    for (const item of materialised) {
      // Existing content is user-owned and already semantically identical;
      // preserving it avoids a second device overwriting tags/favourites.
      if (!(await dbV7.questions.get(item.question.id))) await dbV7.questions.put(item.question);
      await saveMembershipInTx(item.membership);
    }
    for (const note of materialisedNotes) await dbV7.notes.put(note);
    const refreshed = await refreshBankQuestionCountInTx(bank.id);
    if (refreshed) await dbV7.banks.put({ ...refreshed, updatedAt: timestamp, deviceId });
    const bankSnapshot = (await dbV7.banks.get(bank.id))!;
    // A single atomic import change-set. The sync layer offloads any body that
    // exceeds the v7 inline-event budget to a content-addressed immutable
    // object, so a large import no longer needs to be split into byte-bounded
    // chunks here; the whole import applies atomically on every device.
    await enqueueChangeSetV7([{
      kind: "question.import",
      bank: bankSnapshot,
      questions: materialised.map((item) => item.question),
      memberships: materialised.map((item) => item.membership),
      ...(importImages.length ? { images: importImages } : {}),
    }], timestamp);
    if (materialisedNotes.length) {
      // Imported notes publish as a follow-up batch; the queue planner orders
      // them after question.import because each note depends on its question.
      await enqueueChangeSetV7(materialisedNotes.map((note) => ({ kind: "note.upserted" as const, note })), timestamp);
    }
  });
  const imported = await dbV7.banks.get(bank.id);
  return { ...imported!, importedCount: materialised.filter((item) => item.isNewMembership).length };
}

export const importTextJsonBankV7 = importQuestionBankV7;
export const importBankV7 = importQuestionBankV7;
