import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import { ContentBlockRenderer } from "@/app/content-block-renderer";
import { MathText } from "@/app/math-text";
import { ModalPortal } from "@/app/modal-portal";
import { loadImageAssetV6, type QuestionViewModel } from "@/app/question-editor";
import { difficultyLabel, type AttemptSummary } from "@/lib/practice-metrics";

/** Render a question's answer as "A. 选项；B. 选项" (calculation answers pass through). */
export function answerText(question: QuestionViewModel) {
  if (question.type === "计算") return question.answer;
  return question.answer.split("").map((letter) => {
    const index = letter.charCodeAt(0) - 65;
    return `${letter}. ${question.options[index] ?? ""}`;
  }).join("；");
}

/**
 * Shared read-only question detail panel.  Shows the stem, options (with the
 * correct letter highlighted), the answer, scope-labelled attempt metrics and
 * the personal note.  The footer is caller-supplied so the search surface and
 * the bank question manager can each offer their own actions (edit / delete /
 * practise / group).  Editing is triggered by a caller-provided footer button,
 * not by this component.
 */
export function QuestionDetail({ question, metric, scopeLabel, note, onClose, footer }: {
  question: QuestionViewModel;
  metric: AttemptSummary;
  scopeLabel: string;
  note?: string;
  onClose: () => void;
  footer?: ReactNode;
}) {
  return <ModalPortal><div className="search-detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="search-question-detail" role="dialog" aria-modal="true" aria-label="题目详情"><header><div><span className="section-kicker">题目详情</span><h2>{question.type} · {question.bankName}</h2></div><button className="icon-button" aria-label="关闭题目详情" onClick={onClose}><X size={18} /></button></header><div className="search-detail-body"><ContentBlockRenderer blocks={question.canonical.content} loadAsset={loadImageAssetV6} />{question.type !== "计算" && <ol>{question.canonical.options.map((option, index) => <li className={question.answer.includes(String.fromCharCode(65 + index)) ? "answer" : ""} key={`${question.id}-${index}`}><span>{String.fromCharCode(65 + index)}</span><ContentBlockRenderer blocks={option} loadAsset={loadImageAssetV6} />{question.answer.includes(String.fromCharCode(65 + index)) && <Check size={16} />}</li>)}</ol>}<section className="search-answer-card"><strong>正确答案：{question.answer}</strong><p><MathText text={answerText(question)} languageText={question.stem} /></p></section><div className="search-detail-metrics"><span><strong>{metric.total}</strong>作答（{scopeLabel}）</span><span><strong>{metric.correct}</strong>正确</span><span><strong>{metric.wrong}</strong>错误</span><span><strong>{metric.difficulty}</strong>难度 · {difficultyLabel(metric.difficulty)}</span></div><section className="search-detail-note"><strong>个人解析</strong><p>{note || "还没有个人解析，可以通过编辑题目或练习页面继续整理。"}</p></section>{question.tags.length > 0 && <div className="search-detail-tags">{question.tags.map((item) => <span key={item}>{item}</span>)}</div>}</div>{footer && <footer>{footer}</footer>}</aside></div></ModalPortal>;
}
