import { Fragment } from "react";
import { ContentBlockRenderer } from "@/app/bank/content-block-renderer";
import { MathText } from "@/app/ui/math-text";
import type { ContentBlock, TextContentBlock } from "@/lib/db/v7-types";
import { CALCULATION_BLANK_PATTERN, isCalculationAnswerCorrect } from "@/lib/question/question-utils";
import type { LoadAsset } from "@/app/ui/asset-image";

interface CalculationContentRendererProps {
  blocks: readonly ContentBlock[];
  answerCount: number;
  values?: readonly string[];
  expected?: readonly string[];
  tolerancePercent?: number;
  disabled?: boolean;
  idPrefix?: string;
  className?: string;
  loadAsset?: LoadAsset;
  onChange?: (index: number, value: string) => void;
  onLastEnter?: () => void;
}

function splitCalculationText(block: TextContentBlock) {
  const parts: Array<{ text: string } | { blank: number }> = [];
  let cursor = 0;
  for (const match of block.text.matchAll(CALCULATION_BLANK_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ text: block.text.slice(cursor, start) });
    parts.push({ blank: Number(match[1]) - 1 });
    cursor = start + match[0].length;
  }
  if (cursor < block.text.length) parts.push({ text: block.text.slice(cursor) });
  return parts;
}

export function CalculationContentRenderer({
  blocks,
  answerCount,
  values,
  expected,
  tolerancePercent = 0,
  disabled = false,
  idPrefix = "calculation-blank",
  className,
  loadAsset,
  onChange,
  onLastEnter,
}: CalculationContentRendererProps) {
  function renderTextBlock(block: TextContentBlock) {
    return splitCalculationText(block).map((part, partIndex) => {
      if ("text" in part) return <MathText key={`${block.id}-text-${partIndex}`} text={part.text} />;
      const index = part.blank;
      if (index < 0 || index >= answerCount) return <span className="calculation-blank-invalid" key={`${block.id}-invalid-${partIndex}`}>【空{index + 1}】</span>;
      if (!values || !onChange) return <span className="calculation-blank-label" key={`${block.id}-blank-${index}`}>第{index + 1}空</span>;
      const value = values[index] ?? "";
      const resultClass = disabled && expected?.[index]
        ? isCalculationAnswerCorrect(value, expected[index], tolerancePercent) ? " correct" : " wrong"
        : "";
      return <input
        id={`${idPrefix}-${index + 1}`}
        className={`calculation-inline-input${resultClass}`}
        key={`${block.id}-blank-${index}`}
        aria-label={`第${index + 1}空答案`}
        type="number"
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(index, event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          const next = document.getElementById(`${idPrefix}-${index + 2}`) as HTMLInputElement | null;
          if (next) next.focus();
          else onLastEnter?.();
        }}
        placeholder={`第${index + 1}空`}
      />;
    });
  }

  return <ContentBlockRenderer
    blocks={blocks}
    loadAsset={loadAsset}
    className={className}
    renderTextBlock={(block) => <Fragment>{renderTextBlock(block)}</Fragment>}
  />;
}
