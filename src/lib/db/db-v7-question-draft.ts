/** Question draft normalization and content-addressed identity helpers. */
import { dbV7, uniqueStrings } from "./db-v7-core";
import type { QuestionDraftV7 } from "./db-v7-core";
import {
  normalizeContentText,
  plainTextToContentBlocks,
  questionContentFingerprint,
} from "../question/question-content";
import { stableOptionIdForBlocks } from "../question/question-utils";
import type { ContentBlock, QuestionV7, QuestionSolution } from "./v7-types";

export type StructuredQuestionDraftV7 = Omit<QuestionDraftV7, "answer"> & {
  optionIds?: string[];
  solution: QuestionSolution;
};

function normalizeBlocks(blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.map((block, index) => {
    if (block.type === "text") {
      return { ...block, id: block.id || `text-${index}`, text: normalizeContentText(block.text) };
    }
    return { ...block, id: block.id || `image-${index}` };
  });
}

function blocksFromOptions(options: QuestionDraftV7["options"]): ContentBlock[][] {
  return (options ?? []).map((option, optionIndex) => {
    if (Array.isArray(option) && option.every((item) => typeof item === "object")) {
      return normalizeBlocks(option);
    }
    const text = normalizeContentText(String(option ?? ""));
    return plainTextToContentBlocks(text, `option-${optionIndex}-0`);
  });
}

export function questionFromDraft(id: string, draft: StructuredQuestionDraftV7, timestamp: string, deviceId: string): QuestionV7 {
  const content = normalizeBlocks(draft.content ?? plainTextToContentBlocks(draft.stem ?? "", "stem-0"));
  const options = blocksFromOptions(draft.options);
  const optionIds = (draft.type === "判断" || draft.type === "单选" || draft.type === "多选")
    ? (draft.optionIds?.length === options.length ? [...draft.optionIds] : options.map((option) => stableOptionIdForBlocks(option)))
    : [];
  const solution = structuredClone(draft.solution);
  const contentFingerprint = questionContentFingerprint({ type: draft.type, content, options, answer: JSON.stringify(solution) });
  return {
    id,
    type: draft.type,
    content,
    options,
    ...(optionIds.length ? { optionIds } : {}),
    solution,
    tags: uniqueStrings(draft.tags ?? []),
    favorite: Boolean(draft.favorite),
    contentFingerprint,
    updatedAt: timestamp,
    deviceId,
  };
}

export async function findQuestionByFingerprint(fingerprint: string): Promise<QuestionV7 | undefined> {
  return dbV7.questions.where("contentFingerprint").equals(fingerprint).first();
}
