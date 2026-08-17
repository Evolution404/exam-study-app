"use client";
import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, CheckCheck, ChevronLeft, ChevronRight, CircleAlert, ClipboardCheck, ClipboardList, CircleHelp, Copy, Grid3X3, NotebookPen, Pencil, RefreshCw, Star, X } from "lucide-react";
import { dbV7 } from "@/lib/db/db-v7";
import { difficultyLabel, difficultyTone } from "@/lib/practice/practice-metrics";
import { SharedQuestionEditor, loadImageAssetV7 } from "@/app/bank/question-editor";
import { NoteMarkdown } from "@/app/ui/note-markdown";
import { ContentBlockRenderer } from "@/app/bank/content-block-renderer";
import { formatKeyboardShortcut, resolveKeyboardShortcut } from "@/lib/practice/keyboard-shortcuts";
import { shouldSubmitOnChoice } from "@/lib/practice/answer-submission";
import { isCalculationAnswerCorrect } from "@/lib/question/question-utils";
import { displayedAnswer, playAnswerFeedback, recordPracticeAnswer, saveNote, summarizeV7AttemptStats, type PracticeAnswerState, type PracticePreferences, type Question, type QuestionType } from "../helpers";
import { Hint } from "@/app/ui/hint";
import { buildQuestionCopyText, copyTextToClipboard } from "@/lib/question/question-copy";
import { QuestionOverview } from "./question-overview";

export function Practice({ runId, question, initialState, optionOrder, questionIds, questionTypes, answers, index, total, modeLabel, preferences, onStateChange, onJump, onFavorite, onPrevious, onNext, onFinish, onExit }: { runId: string; question: Question; initialState?: PracticeAnswerState; optionOrder?: number[]; questionIds: string[]; questionTypes: Record<string, QuestionType>; answers: Record<string, PracticeAnswerState>; index: number; total: number; modeLabel: string; preferences: PracticePreferences; onStateChange: (state: PracticeAnswerState) => void; onJump: (index: number) => void; onFavorite: () => Promise<void>; onPrevious: () => void; onNext: () => void; onFinish: () => void; onExit: () => void }) {
  const [selected, setSelected] = useState<string[]>(initialState?.selected ?? []);
  const [submitted, setSubmitted] = useState(initialState?.submitted ?? false);
  const [calculationDraft, setCalculationDraft] = useState(question.type === "计算" ? initialState?.selected[0] ?? "" : "");
  const [autoAdvancing, setAutoAdvancing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<{ target: "question" | "questionWithAnswer"; status: "idle" | "copied" | "error" }>({ target: "question", status: "idle" });
  const copyStatusOf = (target: "question" | "questionWithAnswer") => (copyFeedback.target === target ? copyFeedback.status : "idle");
  const [startedAt] = useState(() => Date.now());
  const note = useLiveQuery(() => dbV7.notes.get(question.id), [question.id]);
  const attemptSummary = useLiveQuery(async () => summarizeV7AttemptStats(await dbV7.attemptStats.get(question.id)), [question.id]) ?? summarizeV7AttemptStats();
  const [draft, setDraft] = useState<string | null>(null);
  const [noteEditing, setNoteEditing] = useState(false);
  // 换题时退出编辑态（React 官方「渲染期间调整状态」模式，替代 effect 内 setState）。
  const lastNoteQuestionId = useRef(question.id);
  if (lastNoteQuestionId.current !== question.id) {
    lastNoteQuestionId.current = question.id;
    if (noteEditing) setNoteEditing(false);
  }
  const [noteSaveStatus, setNoteSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const autoNextTimer = useRef<number | undefined>(undefined);
  const copyStatusTimer = useRef<number | undefined>(undefined);
  const noteSaveTimer = useRef<number | undefined>(undefined);
  const draftRef = useRef("");
  const noteDirty = useRef(false);
  const answering = useRef(false);
  const chooseShortcutRef = useRef<(letter: string) => void>(() => undefined);
  const submitShortcutRef = useRef<() => void>(() => undefined);
  const questionCardRef = useRef<HTMLElement>(null);
  const swipeGesture = useRef<{ startX: number; startY: number; lastX: number; lastY: number; startScrollTop: number; axis: "pending" | "horizontal" | "vertical" } | null>(null);
  const effectiveDraft = draft ?? note?.content ?? "";
  const displayOrder = optionOrder?.length === question.options.length ? optionOrder : question.options.map((_, optionIndex) => optionIndex);
  const displayAnswer = displayedAnswer(question, displayOrder);
  const selectedCanonical = question.type === "计算" ? selected[0] ?? "" : [...selected].sort().join("");
  const selectedAnswer = question.type === "计算" ? selectedCanonical : selected
    .map((letter) => displayOrder.indexOf(letter.charCodeAt(0) - 65))
    .filter((displayIndex) => displayIndex >= 0)
    .map((displayIndex) => String.fromCharCode(65 + displayIndex))
    .sort()
    .join("");
  const correct = submitted && (question.type === "计算"
    ? isCalculationAnswerCorrect(selectedCanonical, question.answer, preferences.calculationTolerancePercent)
    : selectedCanonical === [...question.answer].sort().join(""));
  const gaveUp = submitted && selected.length === 0;
  const revealAnswer = submitted && (correct || preferences.showAnswerOnWrong);
  const isLast = index === total - 1;

  useEffect(() => {
    if (draft === null && note?.content !== undefined) draftRef.current = note.content;
  }, [draft, note?.content]);

  useEffect(() => () => {
    window.clearTimeout(autoNextTimer.current);
    window.clearTimeout(copyStatusTimer.current);
    window.clearTimeout(noteSaveTimer.current);
    if (noteDirty.current) void saveNote(question.id, draftRef.current);
  }, [question.id]);

  async function persistNoteDraft() {
    const content = draftRef.current;
    setNoteSaveStatus("saving");
    await saveNote(question.id, content);
    if (draftRef.current === content) {
      noteDirty.current = false;
      setNoteSaveStatus("saved");
    }
  }

  function changeNoteDraft(value: string) {
    setDraft(value);
    draftRef.current = value;
    noteDirty.current = true;
    setNoteSaveStatus("idle");
    window.clearTimeout(noteSaveTimer.current);
    noteSaveTimer.current = window.setTimeout(() => void persistNoteDraft(), 650);
  }

  useEffect(() => {
    if (window.matchMedia("(max-width: 760px)").matches) return;
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isEditingText = target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      if (editing || overviewOpen || isEditingText) return;
      const shortcut = resolveKeyboardShortcut(preferences.keyboardShortcuts, event);
      if (shortcut?.type === "option" && !event.repeat && !submitted && shortcut.optionIndex < displayOrder.length) {
        event.preventDefault();
        const originalIndex = displayOrder[shortcut.optionIndex];
        chooseShortcutRef.current(String.fromCharCode(65 + originalIndex));
      } else if (shortcut?.type === "confirm" && !event.repeat && !submitted) {
        event.preventDefault();
        submitShortcutRef.current();
      } else if (shortcut?.type === "previous" && index > 0) {
        event.preventDefault();
        window.clearTimeout(autoNextTimer.current);
        onPrevious();
      } else if (shortcut?.type === "next" && !isLast) {
        event.preventDefault();
        window.clearTimeout(autoNextTimer.current);
        onNext();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [displayOrder, editing, overviewOpen, index, isLast, onNext, onPrevious, preferences.keyboardShortcuts, submitted]);

  useEffect(() => {
    const card = questionCardRef.current;
    if (!card || !preferences.swipeNavigation) return;
    const interactiveSelector = "input, textarea, select, a, [contenteditable='true'], .practice-head button, .question-meta button, .practice-actions button";
    const resetGesture = () => { swipeGesture.current = null; };
    const onTouchStart = (event: TouchEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.touches.length !== 1 || target?.closest(interactiveSelector)) {
        resetGesture();
        return;
      }
      const touch = event.touches[0];
      const workspace = card.closest<HTMLElement>(".workspace");
      swipeGesture.current = { startX: touch.clientX, startY: touch.clientY, lastX: touch.clientX, lastY: touch.clientY, startScrollTop: workspace?.scrollTop ?? 0, axis: "pending" };
    };
    const onTouchMove = (event: TouchEvent) => {
      const gesture = swipeGesture.current;
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      gesture.lastX = touch.clientX;
      gesture.lastY = touch.clientY;
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      const horizontalDistance = Math.abs(dx);
      const verticalDistance = Math.abs(dy);
      if (gesture.axis === "pending") {
        if (Math.hypot(dx, dy) < 12) return;
        gesture.axis = horizontalDistance >= verticalDistance * .8 ? "horizontal" : "vertical";
      }
      if (gesture.axis !== "horizontal") return;
      if (event.cancelable) event.preventDefault();
      const workspace = card.closest<HTMLElement>(".workspace");
      if (workspace && workspace.scrollTop !== gesture.startScrollTop) workspace.scrollTop = gesture.startScrollTop;
    };
    const onTouchEnd = (event: TouchEvent) => {
      const gesture = swipeGesture.current;
      resetGesture();
      if (!gesture || gesture.axis !== "horizontal") return;
      const touch = event.changedTouches[0];
      const dx = (touch?.clientX ?? gesture.lastX) - gesture.startX;
      const dy = (touch?.clientY ?? gesture.lastY) - gesture.startY;
      const workspace = card.closest<HTMLElement>(".workspace");
      if (workspace) workspace.scrollTop = gesture.startScrollTop;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * .8) return;
      window.clearTimeout(autoNextTimer.current);
      if (dx < 0 && !isLast) onNext();
      else if (dx > 0 && index > 0) onPrevious();
      else return;
      window.requestAnimationFrame(() => workspace?.scrollTo({ top: 0, behavior: "auto" }));
    };
    card.addEventListener("touchstart", onTouchStart, { passive: true });
    card.addEventListener("touchmove", onTouchMove, { passive: false });
    card.addEventListener("touchend", onTouchEnd, { passive: true });
    card.addEventListener("touchcancel", resetGesture, { passive: true });
    return () => {
      card.removeEventListener("touchstart", onTouchStart);
      card.removeEventListener("touchmove", onTouchMove);
      card.removeEventListener("touchend", onTouchEnd);
      card.removeEventListener("touchcancel", resetGesture);
    };
  }, [index, isLast, onNext, onPrevious, preferences.swipeNavigation]);

  async function choose(letter: string) {
    if (submitted) return;
    if (question.type === "多选") {
      const next = selected.includes(letter) ? selected.filter((item) => item !== letter) : [...selected, letter];
      setSelected(next);
      onStateChange({ selected: next, submitted: false });
      return;
    }
    const value = [letter];
    setSelected(value);
    onStateChange({ selected: value, submitted: false });
    if (shouldSubmitOnChoice(question.type, preferences.submitOnSelect)) await submit(value);
  }

  chooseShortcutRef.current = (letter) => { void choose(letter); };

  async function selectAllOptions() {
    if (submitted || question.type !== "多选") return;
    const all = question.options.map((_, optionIndex) => String.fromCharCode(65 + optionIndex));
    setSelected(all);
    onStateChange({ selected: all, submitted: false });
    if (preferences.multiSelectAllAutoSubmit) await submit(all);
  }

  async function submit(valueList = selected) {
    const value = question.type === "计算" ? calculationDraft.trim() : [...valueList].sort().join("");
    if (!value || (question.type === "计算" && !Number.isFinite(Number(value))) || submitted || answering.current) return;
    answering.current = true;
    const finalSelection = question.type === "计算" ? [value] : valueList;
    const isCorrect = question.type === "计算"
      ? isCalculationAnswerCorrect(value, question.answer, preferences.calculationTolerancePercent)
      : value === [...question.answer].sort().join("");
    try {
      const result = await recordPracticeAnswer({ runId, questionId: question.id, bankId: question.bankId, selected: finalSelection, correct: isCorrect, elapsedMs: Date.now() - startedAt });
      setSelected(finalSelection);
      setSubmitted(true);
      onStateChange(result.answer);
    } catch {
      answering.current = false;
      return;
    }
    playAnswerFeedback(isCorrect, preferences);
    if (isCorrect && preferences.autoNextCorrect && !isLast) {
      setAutoAdvancing(true);
      autoNextTimer.current = window.setTimeout(onNext, preferences.autoNextDelayMs);
    }
  }

  submitShortcutRef.current = () => { void submit(); };

  async function giveUp() {
    if (submitted || answering.current) return;
    answering.current = true;
    try {
      const result = await recordPracticeAnswer({ runId, questionId: question.id, bankId: question.bankId, selected: [], correct: false, elapsedMs: Date.now() - startedAt });
      setSelected([]);
      setCalculationDraft("");
      setSubmitted(true);
      onStateChange(result.answer);
    } catch {
      answering.current = false;
      return;
    }
    playAnswerFeedback(false, preferences);
  }

  function retryQuestion() {
    window.clearTimeout(autoNextTimer.current);
    answering.current = false;
    setSelected([]);
    setCalculationDraft("");
    setSubmitted(false);
    setAutoAdvancing(false);
    onStateChange({ selected: [], submitted: false });
  }

  // 复制目标：question = 题目+选项（做错附「我的选择」，绝不带答案）；
  // questionWithAnswer = 额外附一行「正确答案：字母. 选项文本」（做错同样附「我的选择」）。
  async function handleCopyQuestion(target: "question" | "questionWithAnswer") {
    const wrongSelection = submitted && !correct ? selected : undefined;
    const text = buildQuestionCopyText(question, {
      displayOrder,
      includeAnswer: target === "questionWithAnswer",
      wrongSelection,
    });
    const ok = await copyTextToClipboard(text);
    setCopyFeedback({ target, status: ok ? "copied" : "error" });
    window.clearTimeout(copyStatusTimer.current);
    copyStatusTimer.current = window.setTimeout(() => setCopyFeedback((current) => ({ ...current, status: "idle" })), 1800);
  }

  function copyLabel(target: "question" | "questionWithAnswer", status: "idle" | "copied" | "error") {
    if (status === "copied") return "已复制";
    if (status === "error") return "复制失败";
    return target === "question" ? "复制题目" : "复制题目和答案";
  }

  function copyIcon(target: "question" | "questionWithAnswer", status: "idle" | "copied" | "error") {
    if (status === "copied") return <ClipboardCheck size={16} />;
    if (status === "error") return <CircleAlert size={16} />;
    return target === "question" ? <Copy size={16} /> : <ClipboardList size={16} />;
  }

  return <><div className="practice-layout"><section ref={questionCardRef} className="question-card" data-no-pull-refresh><div className="practice-head"><button className="icon-button" aria-label="暂停并返回首页" onClick={onExit}><X size={19} /></button><div className="practice-progress"><span>{index + 1} / {total} · {modeLabel}</span><i><b style={{ width: `${(index + 1) / total * 100}%` }} /></i></div><div className="practice-head-actions"><button className="icon-button overview-trigger" aria-label="打开题目总览" onClick={() => setOverviewOpen(true)}><Grid3X3 size={18} /></button></div></div>
    <div className="question-body"><div className="question-meta"><span>{question.bankName}</span><em className="question-type-chip">{question.type}</em><Hint label="难度按作答时间与作答间隔动态估计：明显快于自己常态、且间隔够久（约半天以上）的做对才显著降低难度；做错会立即推高难度。"><em className={`difficulty-chip difficulty-${difficultyTone(attemptSummary.difficulty)}`}>难度 {attemptSummary.difficulty} · {difficultyLabel(attemptSummary.difficulty)}</em></Hint>{question.tags.map((tag) => <em key={tag}>{tag}</em>)}<span className="question-meta-copy"><Hint label={copyLabel("question", copyStatusOf("question"))}><button type="button" className={`icon-button copy-question ${copyStatusOf("question")}`} aria-label={copyLabel("question", copyStatusOf("question"))} onClick={() => void handleCopyQuestion("question")}>{copyIcon("question", copyStatusOf("question"))}</button></Hint>{submitted && <Hint label={copyLabel("questionWithAnswer", copyStatusOf("questionWithAnswer"))}><button type="button" className={`icon-button copy-question ${copyStatusOf("questionWithAnswer")}`} aria-label={copyLabel("questionWithAnswer", copyStatusOf("questionWithAnswer"))} onClick={() => void handleCopyQuestion("questionWithAnswer")}>{copyIcon("questionWithAnswer", copyStatusOf("questionWithAnswer"))}</button></Hint>}</span><button className={`favorite-question ${question.favorite ? "active" : ""}`} aria-label={question.favorite ? "取消收藏" : "收藏题目"} aria-pressed={Boolean(question.favorite)} onClick={() => void onFavorite()}><Star size={14} fill={question.favorite ? "currentColor" : "none"} />{question.favorite ? "已收藏" : "收藏"}</button><button className="edit-question-link" onClick={() => setEditing(true)}><Pencil size={13} />编辑题目</button></div><ContentBlockRenderer blocks={question.canonical.content} loadAsset={loadImageAssetV7} className="practice-stem" />{question.type === "多选" && !submitted && <div className="multi-select-toolbar"><span>多选题</span><small>{preferences.multiSelectAllAutoSubmit ? "全选后自动确认" : "全选后可继续调整"}</small><button type="button" onClick={() => void selectAllOptions()}><CheckCheck size={15} />全选</button></div>}{question.type === "计算" ? <div className={`calculation-answer ${submitted ? correct ? "correct" : "wrong" : ""}`}><label htmlFor={`calculation-answer-${question.id}`}>输入计算结果</label><input id={`calculation-answer-${question.id}`} aria-label="计算题答案" type="number" inputMode="decimal" value={submitted ? selectedCanonical : calculationDraft} disabled={submitted} onChange={(event) => setCalculationDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} placeholder={`允许误差 ${preferences.calculationTolerancePercent}%`} /><small>按标准答案的相对误差 ±{preferences.calculationTolerancePercent}% 判定</small></div> : <div className="options">{displayOrder.map((originalIndex, displayIndex) => { const option = question.canonical.options[originalIndex] ?? []; const originalLetter = String.fromCharCode(65 + originalIndex); const displayLetter = String.fromCharCode(65 + displayIndex); const isAnswer = revealAnswer && question.answer.includes(originalLetter); const isWrong = submitted && selected.includes(originalLetter) && !question.answer.includes(originalLetter); return <button key={originalLetter} className={`${selected.includes(originalLetter) ? "selected" : ""} ${isAnswer ? "right" : ""} ${isWrong ? "wrong" : ""}`} onClick={() => { if (!window.getSelection()?.toString()) void choose(originalLetter); }}><span>{displayLetter}</span><ContentBlockRenderer blocks={option} loadAsset={loadImageAssetV7} className="practice-option-content" />{isAnswer && <i className="option-status option-status-right" aria-hidden="true"><Check size={18} /></i>}{isWrong && <i className="option-status option-status-wrong" aria-hidden="true"><X size={18} /></i>}</button>; })}</div>}
      {submitted && <><div className={`result-box ${correct ? "success" : "error"}`}><strong>{correct ? (autoAdvancing ? "回答正确，即将进入下一题" : "回答正确") : gaveUp ? "已标记为不会，并计入错题" : "这次没有答对"}</strong>{correct ? <p>正确答案：{displayAnswer}</p> : preferences.showAnswerOnWrong ? <p>正确答案：{displayAnswer}｜你的选择：{selectedAnswer || "不会"}</p> : <p>正确答案已按配置隐藏｜你的选择：{selectedAnswer || "不会"}</p>}</div><div className="attempt-summary"><span><strong>{attemptSummary.total}</strong>总作答</span><span className="correct"><strong>{attemptSummary.correct}</strong>正确</span><span className="wrong"><strong>{attemptSummary.wrong}</strong>错误</span><span className={`difficulty difficulty-${difficultyTone(attemptSummary.difficulty)}`}><strong>{attemptSummary.difficulty}</strong>难度 · {difficultyLabel(attemptSummary.difficulty)}</span></div></>}
      {preferences.keyboardShortcuts.enabled && <div className="keyboard-hint">快捷键：确认 <kbd>{preferences.keyboardShortcuts.bindings.confirm.map(formatKeyboardShortcut).join(" / ") || "未设置"}</kbd> · 上一题 <kbd>{preferences.keyboardShortcuts.bindings.previous.map(formatKeyboardShortcut).join(" / ") || "未设置"}</kbd> · 下一题 <kbd>{preferences.keyboardShortcuts.bindings.next.map(formatKeyboardShortcut).join(" / ") || "未设置"}</kbd></div>}
      {preferences.swipeNavigation && <div className="swipe-hint"><ChevronLeft size={15} />右滑上一题 · 左滑下一题<ChevronRight size={15} /></div>}
    </div><div className={`practice-actions ${submitted ? "submitted" : ""} ${submitted && !correct && preferences.wrongReappearance === "immediate" ? "with-retry" : ""}`}><button className="secondary practice-previous" onClick={onPrevious} disabled={index === 0}><ChevronLeft size={18} />上一题</button><div>{!submitted && <button className="dont-know-action" onClick={() => void giveUp()}><CircleHelp size={17} />不会</button>}{!submitted && question.type !== "多选" && question.type !== "计算" && preferences.submitOnSelect && <span className="answer-action-hint">选择答案后立即判定</span>}{!submitted && (question.type === "计算" || question.type === "多选" || !preferences.submitOnSelect) && <button className="primary practice-submit" disabled={question.type === "计算" ? !calculationDraft.trim() || !Number.isFinite(Number(calculationDraft)) : !selected.length} onClick={() => void submit()}>确认答案</button>}{submitted && !correct && preferences.wrongReappearance === "immediate" && <button className="secondary retry-question" onClick={retryQuestion}><RefreshCw size={16} />立即重答</button>}{autoAdvancing ? <span className="answer-action-hint practice-auto-status">正在自动前进…</span> : <button className="practice-next" onClick={isLast ? onFinish : onNext}>{isLast ? "查看本次结果" : "下一题"}<ChevronRight size={18} /></button>}</div></div></section>
    {submitted && <aside className="note-panel"><div><NotebookPen size={18} /><strong>我的解析</strong></div>{!noteEditing && effectiveDraft.trim() ? <div className="note-panel-view" role="button" tabIndex={0} aria-label="编辑解析，支持 Markdown 与 LaTeX" onClick={() => setNoteEditing(true)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setNoteEditing(true); } }}><NoteMarkdown text={effectiveDraft} /></div> : <textarea value={effectiveDraft} onChange={(event) => changeNoteDraft(event.target.value)} onFocus={() => setNoteEditing(true)} onBlur={() => { if (effectiveDraft.trim()) setNoteEditing(false); }} placeholder="写下错因、口诀或区分条件…（支持 Markdown 与 LaTeX）" />}<span className={`note-save-status ${noteSaveStatus}`}>{noteSaveStatus === "saving" ? "正在自动保存…" : noteSaveStatus === "saved" ? "已自动保存" : "输入后自动保存"}</span><button className="edit-question-button" onClick={() => setEditing(true)}><Pencil size={15} />编辑题目与标签</button><small>切换题目或离开页面前会自动保存解析。</small></aside>}</div>{overviewOpen && <QuestionOverview questionIds={questionIds} questionTypes={questionTypes} answers={answers} currentIndex={index} onClose={() => setOverviewOpen(false)} onJump={(target) => { window.clearTimeout(autoNextTimer.current); onJump(target); setOverviewOpen(false); }} />}{editing && <SharedQuestionEditor question={question.canonical} preferredBankId={question.bankId} onCancel={() => setEditing(false)} onSaved={() => setEditing(false)} />}</>;
}
