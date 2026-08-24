import { CircleAlert, ClipboardCheck, ClipboardList, Copy } from "lucide-react";

export type QuestionCopyStatus = "idle" | "copied" | "error";

export function QuestionCopyAction({ includeAnswer = false, status = "idle", onClick, compact = false }: {
  includeAnswer?: boolean;
  status?: QuestionCopyStatus;
  onClick: () => void;
  compact?: boolean;
}) {
  const actionLabel = includeAnswer ? "复制题目和答案" : "复制题目";
  const ariaLabel = status === "copied"
    ? `${actionLabel}，已复制`
    : status === "error"
      ? `${actionLabel}，复制失败`
      : actionLabel;
  const icon = status === "copied"
    ? <ClipboardCheck size={15} />
    : status === "error"
      ? <CircleAlert size={15} />
      : includeAnswer
        ? <ClipboardList size={15} />
        : <Copy size={15} />;

  return <button
    type="button"
    className={`question-copy-action ${includeAnswer ? "with-answer" : ""} ${status} ${compact ? "compact" : ""}`}
    aria-label={ariaLabel}
    title={ariaLabel}
    onClick={onClick}
  >
    <span className="question-meta question-copy-state-marker">
      <span className={`copy-question ${status}`} aria-hidden="true">{icon}</span>
    </span>
  </button>;
}
