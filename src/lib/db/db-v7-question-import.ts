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
import { solutionFromInput, stableOptionIdForBlocks } from "../question/question-utils";
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
  solution?: unknown;
  tags?: unknown;
}

function rawQuestionRows(raw: unknown): { name?: string; rows: ImportedQuestionRowV7[] } {
  if (Array.isArray(raw)) return { rows: raw as ImportedQuestionRowV7[] };
  if (!raw || typeof raw !== "object") throw new Error("未找到当前 questions 题目数组。");
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.questions)) throw new Error("未找到当前 questions 题目数组。");
  return { name: typeof record.name === "string" ? record.name : undefined, rows: record.questions as ImportedQuestionRowV7[] };
}

const ASSET_ID_PATTERN = /^[0-9a-f]{64}$/;
const PLACEHOLDER_TEST = /【图[0-9]+】/;

/** Sanitise semi-trusted imported blocks: text blocks keep their text, image
 * blocks must reference a materialised 64-hex asset id. Anything else is
 * dropped rather than trusted. */
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

function isQuestionSolution(value: unknown): value is QuestionSolution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "choice") return Array.isArray(record.correctOptionIds) && record.correctOptionIds.length > 0 && record.correctOptionIds.every((id) => typeof id === "string" && id.length > 0) && new Set(record.correctOptionIds).size === record.correctOptionIds.length;
  if (record.kind === "calculation") return Array.isArray(record.blanks) && record.blanks.length > 0 && record.blanks.every((blank) => {
    if (!blank || typeof blank !== "object" || Array.isArray(blank)) return false;
    const item = blank as Record<string, unknown>;
    return typeof item.id === "string" && typeof item.expected === "number" && Number.isFinite(item.expected);
  });
  if (record.kind === "fill") return Array.isArray(record.blanks) && record.blanks.length > 0 && record.blanks.every((blank) => {
    if (!blank || typeof blank !== "object" || Array.isArray(blank)) return false;
    const item = blank as Record<string, unknown>;
    return typeof item.id === "string" && Array.isArray(item.acceptedAnswers) && item.acceptedAnswers.length > 0 && item.acceptedAnswers.every((answer) => typeof answer === "string" && answer.trim().length > 0);
  });
  return record.kind === "short" && typeof record.referenceText === "string" && record.referenceText.trim().length > 0;
}

function solutionMatchesType(type: QuestionTypeV7, solution: QuestionSolution): boolean {
  if (type === "计算") return solution.kind === "calculation";
  if (type === "填空") return solution.kind === "fill";
  if (type === "简答") return solution.kind === "short";
  return solution.kind === "choice";
}

function importDraft(row: ImportedQuestionRowV7): StructuredQuestionDraftV7 | undefined {
  if (!row || typeof row !== "object") return undefined;
  const record = row as unknown as Record<string, unknown>;
  const imageIds = Array.isArray(record.images)
    ? record.images.map(String).filter((id) => ASSET_ID_PATTERN.test(id))
    : [];
  const structuredContent = importedBlocks(record.content);
  const rawStem = normalizeContentText(typeof record.stem === "string" ? record.stem : "");
  const stem = rawStem || (structuredContent ? deriveContentText(structuredContent) : "");
  if (!stem && !structuredContent?.length) return undefined;
  const content = structuredContent ?? (imageIds.length ? blocksFromPlaceholderText(rawStem, imageIds, "stem") : undefined);
  const cleanStem = content ? undefined : (imageIds.length ? rawStem : stripImagePlaceholders(rawStem));
  const rawOptions = record.options;
  const blockOptions = Array.isArray(rawOptions) && rawOptions.length > 0 && rawOptions.every((item) => Array.isArray(item))
    ? rawOptions.map((item, index) => importedBlocks(item) ?? plainTextToContentBlocks("", `option-${index}-0`))
    : undefined;
  const placeholderOption = (value: unknown, index: number) => {
    const optionText = String(value ?? "").trim();
    return imageIds.length && PLACEHOLDER_TEST.test(optionText) ? blocksFromPlaceholderText(optionText, imageIds, `option-${index}`) : optionText;
  };
  const options = blockOptions ?? (Array.isArray(rawOptions) ? rawOptions.map(placeholderOption) : []);
  const optionBlocks = options.map((option, index) => typeof option === "string" ? plainTextToContentBlocks(option, `option-${index}-0`) : option);
  const rawType = typeof record.type === "string" ? record.type.trim() : "";
  const rawAnswer = record.answer ?? "";
  const answer = Array.isArray(rawAnswer)
    ? rawType === "填空" && rawAnswer.every((item) => Array.isArray(item))
      ? rawAnswer.map((item) => (item as unknown[]).map(String).join("||")).join("\n")
      : rawAnswer.map((item) => Array.isArray(item) ? item.map(String).join("||") : String(item)).join(rawType === "计算" || rawType === "填空" ? "\n" : "")
    : String(rawAnswer);
  if (rawType !== "判断" && rawType !== "单选" && rawType !== "多选" && rawType !== "计算" && rawType !== "填空" && rawType !== "简答") return undefined;
  const type: QuestionTypeV7 = rawType;
  if (!["计算", "填空", "简答"].includes(type) && options.length < 2) return undefined;
  const suppliedOptionIds = Array.isArray(record.optionIds) && record.optionIds.length === options.length
    ? record.optionIds.map(String)
    : undefined;
  const optionIds = suppliedOptionIds ?? (type === "单选" || type === "多选" || type === "判断" ? optionBlocks.map(stableOptionIdForBlocks) : undefined);
  const suppliedSolution = isQuestionSolution(record.solution) ? structuredClone(record.solution) : undefined;
  const solution = suppliedSolution ?? (answer.trim() ? solutionFromInput(type, answer, optionBlocks, optionIds) : undefined);
  if (!solution || !solutionMatchesType(type, solution)) return undefined;
  if (optionIds && new Set(optionIds).size !== optionIds.length) return undefined;
  if (solution.kind === "choice") {
    if (!optionIds?.length || !solution.correctOptionIds.length) return undefined;
    const validOptionIds = new Set(optionIds);
    if (new Set(solution.correctOptionIds).size !== solution.correctOptionIds.length || solution.correctOptionIds.some((id) => !validOptionIds.has(id))) return undefined;
  }
  const rawTags = record.tags;
  const tags = Array.isArray(rawTags) ? rawTags.map(String) : String(rawTags ?? "").split(/[，,、\n]+/);
  const note = typeof record.note === "string" ? record.note.trim() : "";
  return {
    type,
    ...(content ? { content } : { stem: cleanStem ?? stem }),
    options,
    solution,
    ...(optionIds ? { optionIds } : {}),
    tags: uniqueStrings(tags),
    ...(note ? { note } : {}),
  };
}

/** Import a current question list. Human/Excel answer columns are converted to
 * canonical solution objects at this boundary; persisted questions never store
 * a parallel answer string. */
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
      if (!(await dbV7.questions.get(item.question.id))) await dbV7.questions.put(item.question);
      await saveMembershipInTx(item.membership);
    }
    for (const note of materialisedNotes) await dbV7.notes.put(note);
    const refreshed = await refreshBankQuestionCountInTx(bank.id);
    if (refreshed) await dbV7.banks.put({ ...refreshed, updatedAt: timestamp, deviceId });
    const bankSnapshot = (await dbV7.banks.get(bank.id))!;
    await enqueueChangeSetV7([{
      kind: "question.import",
      bank: bankSnapshot,
      questions: materialised.map((item) => item.question),
      memberships: materialised.map((item) => item.membership),
      ...(importImages.length ? { images: importImages } : {}),
    }], timestamp);
    if (materialisedNotes.length) {
      await enqueueChangeSetV7(materialisedNotes.map((note) => ({ kind: "note.upserted" as const, note })), timestamp);
    }
  });
  const imported = await dbV7.banks.get(bank.id);
  return { ...imported!, importedCount: materialised.filter((item) => item.isNewMembership).length };
}
