import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { ContentBlockRenderer } from "@/app/bank/content-block-renderer";
import { MathText } from "@/app/ui/math-text";
import { NoteMarkdown } from "@/app/ui/note-markdown";
import { ModalPortal } from "@/app/ui/modal-portal";
import { QuestionCopyAction } from "@/app/ui/question-copy-action";
import { loadImageAssetV7, type QuestionViewModel } from "@/app/bank/question-editor";
import { difficultyLabel, type AttemptSummary } from "@/lib/practice/practice-metrics";
import type { PracticeRunV7 } from "@/lib/db/v7-types";
import { resolveKeyboardShortcut, type KeyboardShortcuts } from "@/lib/practice/keyboard-shortcuts";
import { buildQuestionCopyText, copyTextToClipboard } from "@/lib/question/question-copy";
import { CalculationContentRenderer, FillContentRenderer } from "@/app/practice/calculation-content-renderer";
import { formatCalculationAnswers, stableQuestionOptionIds } from "@/lib/question/question-utils";

/** Render a question's canonical solution as display text. */
export function answerText(question: QuestionViewModel) {
  const solution = question.canonical.solution;
  if (solution.kind === "calculation") return formatCalculationAnswers(solution.blanks.map((blank) => String(blank.expected)));
  if (solution.kind === "fill") return solution.blanks.map((blank, index) => `第${index + 1}空：${blank.acceptedAnswers.join(" / ")}`).join("；");
  if (solution.kind === "short") return `参考答案：${solution.referenceText}`;
  const optionIds = stableQuestionOptionIds(question.canonical);
  return solution.correctOptionIds.map((optionId) => optionIds.indexOf(optionId)).filter((index) => index >= 0).sort((a, b) => a - b).map((index) => {
    const letter = String.fromCharCode(65 + index);
    return `${letter}. ${question.options[index] ?? ""}`;
  }).join("；");
}

/** Shared read-only question detail panel. */
export function QuestionDetail({ question, metric, scopeLabel, note, onClose, footer, nav, answer, answerLabel = "你的答案" }: {
  question: QuestionViewModel;
  metric: AttemptSummary;
  scopeLabel: string;
  note?: string;
  onClose: () => void;
  footer?: ReactNode;
  answer?: PracticeRunV7["answers"][string];
  answerLabel?: string;
  nav?: {
    index: number;
    total: number;
    onPrevious: () => void;
    onNext: () => void;
    keyboardShortcuts: KeyboardShortcuts;
    swipeNavigation: boolean;
    center?: ReactNode;
  };
}) {
  type CopyTarget = "question" | "questionWithAnswer";
  const panelRef = useRef<HTMLElement>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ target: CopyTarget; status: "idle" | "copied" | "error" }>({ target: "question", status: "idle" });
  const copyStatusTimer = useRef<number | undefined>(undefined);
  const copyStatusOf = (target: CopyTarget) => copyFeedback.target === target ? copyFeedback.status : "idle";

  useEffect(() => () => window.clearTimeout(copyStatusTimer.current), []);

  async function handleCopyQuestion(target: CopyTarget) {
    const wrongSelection = answer?.submitted && answer.correct === false ? answer.selected : undefined;
    const ok = await copyTextToClipboard(buildQuestionCopyText(question, {
      includeAnswer: target === "questionWithAnswer",
      wrongSelection,
    }));
    setCopyFeedback({ target, status: ok ? "copied" : "error" });
    window.clearTimeout(copyStatusTimer.current);
    copyStatusTimer.current = window.setTimeout(() => setCopyFeedback((current) => ({ ...current, status: "idle" })), 1800);
  }

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")) return;
      event.preventDefault();
      onClose();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  useEffect(() => {
    if (!nav) return;
    const n = nav;
    if (window.matchMedia("(max-width: 760px)").matches) return;
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")) return;
      const shortcut = resolveKeyboardShortcut(n.keyboardShortcuts, event);
      if (shortcut?.type === "previous" && n.index > 0) { event.preventDefault(); n.onPrevious(); }
      else if (shortcut?.type === "next" && n.index < n.total - 1) { event.preventDefault(); n.onNext(); }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [nav]);

  useEffect(() => {
    if (!nav || !nav.swipeNavigation) return;
    const n = nav;
    const panel = panelRef.current;
    if (!panel) return;
    const body = panel.querySelector<HTMLElement>(".search-detail-body");
    const interactiveSelector = "input, textarea, select, a, [contenteditable='true'], button";
    let gesture: { startX: number; startY: number; lastX: number; lastY: number; startScrollTop: number; axis: "pending" | "horizontal" | "vertical" } | null = null;
    const resetGesture = () => { gesture = null; };
    const onTouchStart = (event: TouchEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.touches.length !== 1 || target?.closest(interactiveSelector)) { resetGesture(); return; }
      const touch = event.touches[0];
      gesture = { startX: touch.clientX, startY: touch.clientY, lastX: touch.clientX, lastY: touch.clientY, startScrollTop: body?.scrollTop ?? 0, axis: "pending" };
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      gesture.lastX = touch.clientX;
      gesture.lastY = touch.clientY;
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      if (gesture.axis === "pending") {
        if (Math.hypot(dx, dy) < 12) return;
        gesture.axis = Math.abs(dx) >= Math.abs(dy) * 0.8 ? "horizontal" : "vertical";
      }
      if (gesture.axis !== "horizontal") return;
      if (event.cancelable) event.preventDefault();
      if (body && body.scrollTop !== gesture.startScrollTop) body.scrollTop = gesture.startScrollTop;
    };
    const onTouchEnd = (event: TouchEvent) => {
      const finished = gesture;
      resetGesture();
      if (!finished || finished.axis !== "horizontal") return;
      const touch = event.changedTouches[0];
      const dx = (touch?.clientX ?? finished.lastX) - finished.startX;
      const dy = (touch?.clientY ?? finished.lastY) - finished.startY;
      if (body) body.scrollTop = finished.startScrollTop;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 0.8) return;
      if (dx < 0 && n.index < n.total - 1) n.onNext();
      else if (dx > 0 && n.index > 0) n.onPrevious();
    };
    panel.addEventListener("touchstart", onTouchStart, { passive: true });
    panel.addEventListener("touchmove", onTouchMove, { passive: false });
    panel.addEventListener("touchend", onTouchEnd, { passive: true });
    panel.addEventListener("touchcancel", resetGesture, { passive: true });
    return () => {
      panel.removeEventListener("touchstart", onTouchStart);
      panel.removeEventListener("touchmove", onTouchMove);
      panel.removeEventListener("touchend", onTouchEnd);
      panel.removeEventListener("touchcancel", resetGesture);
    };
  }, [nav]);

  const detailSolution = question.canonical.solution;
  const detailOptionIds = stableQuestionOptionIds(question.canonical);
  const bodyStyle = { flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", WebkitOverflowScrolling: "touch", paddingBottom: 18 } as const;
  const navStyle = { paddingBottom: "var(--app-safe-bottom)" } as const;
  return <ModalPortal><div className="search-detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside ref={panelRef} className="search-question-detail" role="dialog" aria-modal="true" aria-label="题目详情"><header><div><span className="section-kicker">题目详情</span><h2>{question.type} · {question.bankName}</h2></div><button className="icon-button question-detail-close" aria-label="关闭题目详情" onClick={onClose}><X size={18} /></button></header><div className="question-detail-toolbar" aria-label="题目操作"><QuestionCopyAction status={copyStatusOf("question")} onClick={() => void handleCopyQuestion("question")} /><QuestionCopyAction includeAnswer status={copyStatusOf("questionWithAnswer")} onClick={() => void handleCopyQuestion("questionWithAnswer")} />{footer && <div className="question-detail-actions">{footer}</div>}</div><div className="search-detail-body" style={bodyStyle}>{detailSolution.kind === "calculation" ? <CalculationContentRenderer blocks={question.canonical.content} answerCount={detailSolution.blanks.length} loadAsset={loadImageAssetV7} /> : detailSolution.kind === "fill" ? <FillContentRenderer blocks={question.canonical.content} blankCount={detailSolution.blanks.length} expected={detailSolution} loadAsset={loadImageAssetV7} /> : <ContentBlockRenderer blocks={question.canonical.content} loadAsset={loadImageAssetV7} />}{detailSolution.kind === "short" && <section className="search-answer-card"><strong>参考答案</strong><p>{detailSolution.referenceText}</p>{answer && <p>{answerLabel}：{answer.submitted ? answer.selected.length ? [...answer.selected].sort().join("") : "不会" : "未作答"}</p>}</section>}{detailSolution.kind === "choice" && <ol>{question.canonical.options.map((option, index) => { const letter = String.fromCharCode(65 + index); const isAnswer = detailSolution.correctOptionIds.includes(detailOptionIds[index]); const isWrong = Boolean(answer?.submitted && answer.correct === false && answer.selected.includes(letter) && !isAnswer); return <li className={isAnswer ? "answer" : isWrong ? "wrong" : ""} key={`${question.id}-${index}`}><span>{letter}</span><ContentBlockRenderer blocks={option} loadAsset={loadImageAssetV7} />{isAnswer && <Check size={16} />}{isWrong && <X size={16} />}</li>; })}</ol>}{detailSolution.kind !== "short" && <section className="search-answer-card"><strong>正确答案</strong><p><MathText text={answerText(question)} languageText={question.stem} /></p>{answer && <p>{answerLabel}：{answer.submitted ? answer.selected.length ? question.type === "计算" ? formatCalculationAnswers(answer.selected) : [...answer.selected].sort().join("") : "不会" : "未作答"}</p>}</section>}<div className="search-detail-metrics"><span><strong>{metric.total}</strong>作答（{scopeLabel}）</span><span><strong>{metric.correct}</strong>正确</span><span><strong>{metric.wrong}</strong>错误</span><span><strong>{metric.difficulty}</strong>个人难度 · {difficultyLabel(metric.difficulty)}</span></div><section className="search-detail-note"><strong>个人解析</strong>{note ? <NoteMarkdown text={note} /> : <p>还没有个人解析，可以通过编辑题目或练习页面继续整理。</p>}</section>{question.tags.length > 0 && <div className="search-detail-tags">{question.tags.map((item) => <span key={item}>{item}</span>)}</div>}</div>{nav && <footer className="question-detail-pager"><div className="search-detail-nav" style={navStyle}><button type="button" className="secondary question-detail-previous" disabled={nav.index === 0} onClick={nav.onPrevious}><ChevronLeft size={17} />上一题</button><div className="search-detail-position">{nav.center ?? <span className="search-detail-count">{nav.index + 1} / {nav.total}</span>}</div><button type="button" className="question-detail-next" disabled={nav.index >= nav.total - 1} onClick={nav.onNext}>下一题<ChevronRight size={17} /></button></div></footer>}</aside></div></ModalPortal>;
}
