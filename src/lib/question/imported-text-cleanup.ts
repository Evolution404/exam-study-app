import type { ContentBlock, QuestionV7 } from "../db/v7-types";

const VISUAL_WRAP_EXTRACTION_SOURCE = /原图提取版/i;

/** Only this known extraction source uses newlines as visual hard wraps. */
export function isVisualWrapExtractionSource(sourceName: string): boolean {
  return VISUAL_WRAP_EXTRACTION_SOURCE.test(sourceName);
}

/** Collapse extraction hard wraps without normalizing any other whitespace. */
export function collapseExtractedVisualLineBreaks(value: string): string {
  return value.replace(/[ \t]*(?:\r\n|\r|\n|\u2028|\u2029)+[ \t]*/g, "");
}

function cleanBlocks(blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => block.type === "text"
    ? { ...block, text: collapseExtractedVisualLineBreaks(block.text) }
    : { ...block });
}

/** Presentation cleanup for an affected workbook that is already in IndexedDB. */
export function cleanVisualWrapQuestion(question: QuestionV7, sourceName: string): QuestionV7 {
  if (!isVisualWrapExtractionSource(sourceName)) return question;
  return {
    ...question,
    content: cleanBlocks(question.content),
    options: question.options.map((option) => cleanBlocks(option)),
  };
}
