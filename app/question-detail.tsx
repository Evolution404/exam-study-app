import { useEffect, useRef, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { ContentBlockRenderer } from "@/app/content-block-renderer";
import { MathText } from "@/app/math-text";
import { NoteMarkdown } from "@/app/note-markdown";
import { ModalPortal } from "@/app/modal-portal";
import { loadImageAssetV6, type QuestionViewModel } from "@/app/question-editor";
import { difficultyLabel, type AttemptSummary } from "@/lib/practice-metrics";
import { resolveKeyboardShortcut, type KeyboardShortcuts } from "@/lib/keyboard-shortcuts";

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
 * practise / group).
 *
 * When `nav` is provided, the panel also offers previous/next navigation (like
 * the practice surface): a keyboard shortcut on desktop and a horizontal swipe
 * on mobile, plus a bottom nav row next to the caller's actions.
 */
export function QuestionDetail({ question, metric, scopeLabel, note, onClose, footer, nav }: {
  question: QuestionViewModel;
  metric: AttemptSummary;
  scopeLabel: string;
  note?: string;
  onClose: () => void;
  footer?: ReactNode;
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
  const panelRef = useRef<HTMLElement>(null);

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

  return <ModalPortal><div className="search-detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside ref={panelRef} className="search-question-detail" role="dialog" aria-modal="true" aria-label="题目详情"><header><div><span className="section-kicker">题目详情</span><h2>{question.type} · {question.bankName}</h2></div><button className="icon-button" aria-label="关闭题目详情" onClick={onClose}><X size={18} /></button></header><div className="search-detail-body"><ContentBlockRenderer blocks={question.canonical.content} loadAsset={loadImageAssetV6} />{question.type !== "计算" && <ol>{question.canonical.options.map((option, index) => <li className={question.answer.includes(String.fromCharCode(65 + index)) ? "answer" : ""} key={`${question.id}-${index}`}><span>{String.fromCharCode(65 + index)}</span><ContentBlockRenderer blocks={option} loadAsset={loadImageAssetV6} />{question.answer.includes(String.fromCharCode(65 + index)) && <Check size={16} />}</li>)}</ol>}<section className="search-answer-card"><strong>正确答案：{question.answer}</strong><p><MathText text={answerText(question)} languageText={question.stem} /></p></section><div className="search-detail-metrics"><span><strong>{metric.total}</strong>作答（{scopeLabel}）</span><span><strong>{metric.correct}</strong>正确</span><span><strong>{metric.wrong}</strong>错误</span><span><strong>{metric.difficulty}</strong>难度 · {difficultyLabel(metric.difficulty)}</span></div><section className="search-detail-note"><strong>个人解析</strong>{note ? <NoteMarkdown text={note} /> : <p>还没有个人解析，可以通过编辑题目或练习页面继续整理。</p>}</section>{question.tags.length > 0 && <div className="search-detail-tags">{question.tags.map((item) => <span key={item}>{item}</span>)}</div>}</div>{footer && <footer>{nav?.center && <div className="search-detail-position">{nav.center}</div>}<div className="search-detail-actions">{footer}</div>{nav && <div className="search-detail-nav"><button type="button" className="secondary-action" disabled={nav.index === 0} onClick={nav.onPrevious}><ChevronLeft size={17} />上一题</button><button type="button" className="secondary-action" disabled={nav.index >= nav.total - 1} onClick={nav.onNext}>下一题<ChevronRight size={17} /></button></div>}</footer>}</aside></div></ModalPortal>;
}
