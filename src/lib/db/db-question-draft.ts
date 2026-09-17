/** Question draft normalization and content-addressed identity helpers. */
import { studyDb, uniqueStrings } from "./db-core";
import type { QuestionDraft } from "./db-core";
import {
  normalizeContentText,
  plainTextToContentBlocks,
  questionContentFingerprint,
} from "../question/question-content";
import { stableQuestionOptionIds } from "../question/question-utils";
import type { ContentBlock, Question, QuestionSolution } from "./types";

export type StructuredQuestionDraft = Omit<QuestionDraft, "answer"> & {
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

function blocksFromOptions(options: QuestionDraft["options"]): ContentBlock[][] {
  return (options ?? []).map((option, optionIndex) => {
    if (Array.isArray(option) && option.every((item) => typeof item === "object")) {
      return normalizeBlocks(option);
    }
    const text = normalizeContentText(String(option ?? ""));
    return plainTextToContentBlocks(text, `option-${optionIndex}-0`);
  });
}

export function questionFromDraft(id: string, draft: StructuredQuestionDraft, timestamp: string, deviceId: string): Question {
  const content = normalizeBlocks(draft.content ?? plainTextToContentBlocks(draft.stem ?? "", "stem-0"));
  const options = blocksFromOptions(draft.options);
  const optionIds = (draft.type === "判断" || draft.type === "单选" || draft.type === "多选")
    ? (draft.optionIds?.length === options.length ? [...draft.optionIds] : stableQuestionOptionIds({ options }))
    : [];
  const solution = structuredClone(draft.solution);
  const contentFingerprint = questionContentFingerprint({ type: draft.type, content, options, solution });
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

export async function findQuestionByFingerprint(fingerprint: string): Promise<Question | undefined> {
  return studyDb.questions.where("contentFingerprint").equals(fingerprint).first();
}
