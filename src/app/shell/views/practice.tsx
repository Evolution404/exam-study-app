"use client";
import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, CheckCheck, X } from "lucide-react";
import { dbV7 } from "@/lib/db/db-v7";
import { SharedQuestionEditor, loadImageAssetV7 } from "@/app/bank/question-editor";
import { ContentBlockRenderer } from "@/app/bank/content-block-renderer";
import { CalculationContentRenderer, FillContentRenderer } from "@/app/practice/calculation-content-renderer";
import { resolveKeyboardShortcut } from "@/lib/practice/keyboard-shortcuts";
import { shouldSubmitOnChoice } from "@/lib/practice/answer-submission";
import { areCalculationAnswersCorrect, calculationAnswers, calculationBlankIndexes, fillAnswersAreCorrect, formatCalculationAnswers, questionSolution, stableQuestionOptionIds } from "@/lib/question/question-utils";
import type { AttemptOutcome } from "@/lib/db/v7-types";
import { displayedAnswer, playAnswerFeedback, recordPracticeAnswer, saveNote, summarizeV7AttemptStats, type PracticeAnswerState, type PracticePreferences, type Question, type QuestionType } from "../helpers";
import { buildQuestionCopyText, copyTextToClipboard } from "@/lib/question/question-copy";
import { ActiveElapsedTimer } from "@/lib/practice/active-elapsed-time";
import { QuestionOverview } from "./question-overview";
import { PracticeActionBar, PracticeHeader, PracticeNavigationHints, PracticeNotePanel, PracticeQuestionHeading, PracticeResultSummary } from "./practice-presentation";

export function Practice({ runId, question, initialState, optionOrder, questionIds, questionTypes, answers, index, total, modeLabel, preferences, onStateChange, onJump, onFavorite, onPrevious, onNext, onFinish, onExit }: { runId: string; question: Question; initialState?: PracticeAnswerState; optionOrder?: number[]; questionIds: string[]; questionTypes: Record<string, QuestionType>; answers: Record<string, PracticeAnswerState>; index: number; total: number; modeLabel: string; preferences: PracticePreferences; onStateChange: (state: PracticeAnswerState) => void; onJump: (index: number) => void; onFavorite: () => Promise<void>; onPrevious: () => void; onNext: () => void; onFinish: () => void; onExit: () => void }) {
  const [selected, setSelected] = useState<string[]>(initialState?.selected ?? []);
  const [submitted, setSubmitted] = useState(initialState?.submitted ?? false);
  const solution = questionSolution(question.canonical);
  const optionIds = solution.kind === "choice" ? stableQuestionOptionIds(question.canonical) : [];
  const correctOptionIds = solution.kind === "choice" ? new Set(solution.correctOptionIds) : new Set<string>();
  const expectedCalculationAnswers = solution.kind === "calculation" ? solution.blanks.map((blank) => String(blank.expected)) : question.type === "计算" ? calculationAnswers(question.answer) : [];
  const expectedFillSolution = solution.kind === "fill" ? solution : undefined;
  const shortSolution = solution.kind === "short" ? solution : undefined;
  const [calculationDrafts, setCalculationDrafts] = useState<string[]>(question.type === "计算"
    ? initialState?.selected ?? Array.from({ length: expectedCalculationAnswers.length }, () => "")
    : []);
  const [fillDrafts, setFillDrafts] = useState<string[]>(question.type === "填空"
    ? initialState?.selected ?? Array.from({ length: expectedFillSolution?.blanks.length ?? 1 }, () => "")
    : []);
  const [shortOutcome, setShortOutcome] = useState<AttemptOutcome | undefined>(initialState?.outcome);
  const [autoAdvancing, setAutoAdvancing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<{ target: "question" | "questionWithAnswer"; status: "idle" | "copied" | "error" }>({ target: "question", status: "idle" });
  const copyStatusOf = (target: "question" | "questionWithAnswer") => (copyFeedback.target === target ? copyFeedback.status : "idle");
  const activeTimer = useRef<ActiveElapsedTimer | null>(null);
  const note = useLiveQuery(() => dbV7.notes.get(question.id), [question.id]);
  const attemptSummary = useLiveQuery(async () => summarizeV7AttemptStats(await dbV7.attemptStats.get(question.id)), [question.id]) ?? summarizeV7AttemptStats();
  const [draft, setDraft] = useState<string | null>(null);
  const [noteEditingQuestionId, setNoteEditingQuestionId] = useState<string | null>(null);
  const noteEditing = noteEditingQuestionId === question.id;
  const setNoteEditing = (value: boolean) => setNoteEditingQuestionId(value ? question.id : null);
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
  const selectedAnswer = question.type === "计算" ? formatCalculationAnswers(selected) : question.type === "填空" ? selected.join("；") : question.type === "简答" ? selected.join("\n") : selected
    .map((letter) => displayOrder.indexOf(letter.charCodeAt(0) - 65))
    .filter((displayIndex) => displayIndex >= 0)
    .map((displayIndex) => String.fromCharCode(65 + displayIndex))
    .sort()
    .join("");
  const correct = submitted && (question.type === "计算"
    ? areCalculationAnswersCorrect(selected, expectedCalculationAnswers, preferences.calculationTolerancePercent)
    : question.type === "填空"
      ? Boolean(expectedFillSolution && fillAnswersAreCorrect(selected, expectedFillSolution))
      : question.type === "简答"
        ? shortOutcome === "correct"
        : solution.kind === "choice" && (() => {
          const selectedOptionIds = selected.map((letter) => optionIds[letter.charCodeAt(0) - 65]).filter((id): id is string => Boolean(id));
          return selectedOptionIds.length === correctOptionIds.size && selectedOptionIds.every((id) => correctOptionIds.has(id));
        })());
  const hasInlineCalculationBlanks = question.type === "计算"
    && calculationBlankIndexes(question.stem).length === expectedCalculationAnswers.length;
  const hasInlineFillBlanks = question.type === "填空"
    && calculationBlankIndexes(question.stem).length === (expectedFillSolution?.blanks.length ?? 0);
  const calculationInputValid = question.type === "计算"
    && calculationDrafts.length === expectedCalculationAnswers.length
    && calculationDrafts.every((value) => value.trim() && Number.isFinite(Number(value)));
  const fillInputValid = question.type === "填空" && fillDrafts.length === (expectedFillSolution?.blanks.length ?? 0) && fillDrafts.every((value) => value.trim());
  const gaveUp = submitted && selected.length === 0;
  const revealAnswer = submitted && (correct || preferences.showAnswerOnWrong);
  const isLast = index === total - 1;

  useEffect(() => {
    activeTimer.current = new ActiveElapsedTimer(performance.now());
    return () => { activeTimer.current = null; };
  }, [question.id]);

  useEffect(() => {
    if (draft === null && note?.content !== undefined) draftRef.current = note.content;
  }, [draft, note?.content]);

  useEffect(() => {
    const syncTimerState = () => activeTimer.current?.setPaused(document.hidden || editing || overviewOpen || submitted, performance.now());
    syncTimerState();
    document.addEventListener("visibilitychange", syncTimerState);
    return () => {
      document.removeEventListener("visibilitychange", syncTimerState);
      activeTimer.current?.setPaused(true, performance.now());
    };
  }, [editing, overviewOpen, submitted]);

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
    const interactiveSelector = "input, textarea, select, a, [contenteditable='true'], .practice-head button, .question-tools button, .practice-actions button";
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

  async function selectAllOptions() {
    if (submitted || question.type !== "多选") return;
    const all = question.options.map((_, optionIndex) => String.fromCharCode(65 + optionIndex));
    setSelected(all);
    onStateChange({ selected: all, submitted: false });
    if (preferences.multiSelectAllAutoSubmit) await submit(all);
  }

  async function submit(valueList = selected, manualOutcome?: AttemptOutcome) {
    const calculationValues = calculationDrafts.map((value) => value.trim());
    const fillValues = fillDrafts.map((value) => value.trim());
    const value = question.type === "计算" ? calculationValues.join("\n") : question.type === "填空" ? fillValues.join("\n") : question.type === "简答" ? valueList.join("\n") : [...valueList].sort().join("");
    if (!value || (question.type === "计算" && !calculationInputValid) || (question.type === "填空" && !fillInputValid) || (question.type === "简答" && !manualOutcome) || submitted || answering.current) return;
    answering.current = true;
    const finalSelection = question.type === "计算" ? calculationValues : question.type === "填空" ? fillValues : valueList;
    const isCorrect = question.type === "计算"
      ? areCalculationAnswersCorrect(calculationValues, expectedCalculationAnswers, preferences.calculationTolerancePercent)
      : question.type === "填空"
        ? Boolean(expectedFillSolution && fillAnswersAreCorrect(fillValues, expectedFillSolution))
        : question.type === "简答"
          ? manualOutcome === "correct"
          : value === [...question.answer].sort().join("");
    try {
      const result = await recordPracticeAnswer({ runId, questionId: question.id, bankId: question.bankId, selected: finalSelection, correct: isCorrect, outcome: question.type === "简答" ? manualOutcome : undefined, elapsedMs: activeTimer.current?.elapsedMs(window.performance.now()) ?? 0 });
      setSelected(finalSelection);
      if (question.type === "简答") setShortOutcome(manualOutcome);
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

  useEffect(() => {
    chooseShortcutRef.current = (letter) => { void choose(letter); };
    submitShortcutRef.current = () => { void submit(); };
  });

  async function giveUp() {
    if (submitted || answering.current) return;
    answering.current = true;
    try {
      const result = await recordPracticeAnswer({ runId, questionId: question.id, bankId: question.bankId, selected: [], correct: false, elapsedMs: activeTimer.current?.elapsedMs(window.performance.now()) ?? 0 });
      setSelected([]);
      setCalculationDrafts(Array.from({ length: expectedCalculationAnswers.length }, () => ""));
      setFillDrafts(Array.from({ length: expectedFillSolution?.blanks.length ?? 1 }, () => ""));
      setShortOutcome("skipped");
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
    activeTimer.current?.reset(window.performance.now(), document.hidden || editing || overviewOpen);
    answering.current = false;
    setSelected([]);
    setCalculationDrafts(Array.from({ length: expectedCalculationAnswers.length }, () => ""));
    setFillDrafts(Array.from({ length: expectedFillSolution?.blanks.length ?? 1 }, () => ""));
    setShortOutcome(undefined);
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

  return <>
    <div className="practice-layout">
      <section ref={questionCardRef} className="question-card" data-no-pull-refresh>
        <PracticeHeader index={index} total={total} modeLabel={modeLabel} onExit={onExit} onOpenOverview={() => setOverviewOpen(true)} />
        <div className="question-body">
          <PracticeQuestionHeading
            question={question}
            attemptSummary={attemptSummary}
            submitted={submitted}
            copyQuestionStatus={copyStatusOf("question")}
            copyAnswerStatus={copyStatusOf("questionWithAnswer")}
            onCopyQuestion={() => void handleCopyQuestion("question")}
            onCopyQuestionWithAnswer={() => void handleCopyQuestion("questionWithAnswer")}
            onFavorite={() => void onFavorite()}
            onEdit={() => setEditing(true)}
          />
          {question.type === "计算" && hasInlineCalculationBlanks ? <CalculationContentRenderer blocks={question.canonical.content} loadAsset={loadImageAssetV7} className="practice-stem calculation-practice-stem" answerCount={expectedCalculationAnswers.length} values={submitted ? selected : calculationDrafts} expected={expectedCalculationAnswers} tolerancePercent={preferences.calculationTolerancePercent} disabled={submitted} idPrefix={`calculation-answer-${question.id}`} onChange={(blankIndex, value) => setCalculationDrafts((current) => current.map((item, itemIndex) => itemIndex === blankIndex ? value : item))} onLastEnter={() => void submit()} /> : question.type === "填空" && hasInlineFillBlanks ? <FillContentRenderer blocks={question.canonical.content} loadAsset={loadImageAssetV7} className="practice-stem fill-practice-stem" blankCount={expectedFillSolution?.blanks.length ?? 0} values={submitted ? selected : fillDrafts} expected={expectedFillSolution} disabled={submitted} idPrefix={`fill-answer-${question.id}`} onChange={(blankIndex, value) => setFillDrafts((current) => current.map((item, itemIndex) => itemIndex === blankIndex ? value : item))} onLastEnter={() => void submit()} /> : <ContentBlockRenderer blocks={question.canonical.content} loadAsset={loadImageAssetV7} className="practice-stem" />}
          {question.type === "多选" && !submitted && <div className="multi-select-toolbar"><span>多选题</span><small>{preferences.multiSelectAllAutoSubmit ? "全选后自动确认" : "全选后可继续调整"}</small><button type="button" onClick={() => void selectAllOptions()}><CheckCheck size={15} />全选</button></div>}
          {question.type === "计算" ? (!hasInlineCalculationBlanks && <div className={`calculation-answer fallback-grid ${submitted ? correct ? "correct" : "wrong" : ""}`}><div><strong>输入计算结果</strong><small>每个空分别按标准答案的相对误差 ±{preferences.calculationTolerancePercent}% 判定，全部正确才算答对。</small></div><div className="calculation-fallback-inputs">{calculationDrafts.map((value, blankIndex) => <label key={blankIndex}>第{blankIndex + 1}空<input id={`calculation-answer-${question.id}-${blankIndex + 1}`} aria-label={`第${blankIndex + 1}空答案`} type="number" inputMode="decimal" value={submitted ? selected[blankIndex] ?? "" : value} disabled={submitted} onChange={(event) => setCalculationDrafts((current) => current.map((item, itemIndex) => itemIndex === blankIndex ? event.currentTarget.value : item))} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} /></label>)}</div></div>) : question.type === "填空" ? (!hasInlineFillBlanks && <div className={`calculation-answer fallback-grid fill-fallback-grid ${submitted ? correct ? "correct" : "wrong" : ""}`}><div><strong>填写答案</strong><small>每个空按标准文本答案规范化后逐空判定，全部正确才算答对。</small></div><div className="calculation-fallback-inputs">{fillDrafts.map((value, blankIndex) => <label key={blankIndex}>第{blankIndex + 1}空<input id={`fill-answer-${question.id}-${blankIndex + 1}`} aria-label={`第${blankIndex + 1}空答案`} type="text" value={submitted ? selected[blankIndex] ?? "" : value} disabled={submitted} onChange={(event) => setFillDrafts((current) => current.map((item, itemIndex) => itemIndex === blankIndex ? event.currentTarget.value : item))} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} /></label>)}</div></div>) : question.type === "简答" ? <div className="short-answer-card"><label><span>我的回答</span><textarea aria-label="简答题回答" value={selected[0] ?? ""} disabled={submitted} onChange={(event) => { const next = [event.currentTarget.value]; setSelected(next); onStateChange({ selected: next, submitted: false }); }} placeholder="先回忆要点，再参考答案自评。" rows={6} /></label>{submitted && shortSolution && <div className="short-reference"><strong>参考答案</strong><p>{shortSolution.referenceText}</p></div>}</div> : <div className="options">{displayOrder.map((originalIndex, displayIndex) => { const option = question.canonical.options[originalIndex] ?? []; const originalLetter = String.fromCharCode(65 + originalIndex); const displayLetter = String.fromCharCode(65 + displayIndex); const originalOptionId = optionIds[originalIndex]; const isAnswer = revealAnswer && correctOptionIds.has(originalOptionId ?? ""); const isWrong = submitted && selected.includes(originalLetter) && !correctOptionIds.has(originalOptionId ?? ""); return <button key={originalLetter} className={`${selected.includes(originalLetter) ? "selected" : ""} ${isAnswer ? "right" : ""} ${isWrong ? "wrong" : ""}`} onClick={() => { if (!window.getSelection()?.toString()) void choose(originalLetter); }}><span>{displayLetter}</span><ContentBlockRenderer blocks={option} loadAsset={loadImageAssetV7} className="practice-option-content" />{isAnswer && <i className="option-status option-status-right" aria-hidden="true"><Check size={18} /></i>}{isWrong && <i className="option-status option-status-wrong" aria-hidden="true"><X size={18} /></i>}</button>; })}</div>}
          <PracticeResultSummary
            submitted={submitted}
            correct={correct}
            questionType={question.type}
            shortOutcome={shortOutcome}
            autoAdvancing={autoAdvancing}
            gaveUp={gaveUp}
            displayAnswer={displayAnswer}
            selectedAnswer={selectedAnswer}
            showAnswerOnWrong={preferences.showAnswerOnWrong}
            attemptSummary={attemptSummary}
          />
          <PracticeNavigationHints preferences={preferences} />
        </div>
        <PracticeActionBar
          submitted={submitted}
          correct={correct}
          questionType={question.type}
          preferences={preferences}
          selectedCount={selected.length}
          shortHasAnswer={Boolean(selected[0]?.trim())}
          calculationInputValid={calculationInputValid}
          fillInputValid={fillInputValid}
          autoAdvancing={autoAdvancing}
          index={index}
          isLast={isLast}
          onPrevious={onPrevious}
          onGiveUp={() => void giveUp()}
          onSubmit={() => void submit()}
          onGrade={(outcome) => void submit(selected, outcome)}
          onRetry={retryQuestion}
          onFinish={onFinish}
          onNext={onNext}
        />
      </section>
      <PracticeNotePanel
        submitted={submitted}
        editing={noteEditing}
        draft={effectiveDraft}
        saveStatus={noteSaveStatus}
        onStartEditing={() => setNoteEditing(true)}
        onStopEditing={() => setNoteEditing(false)}
        onChange={changeNoteDraft}
        onEditQuestion={() => setEditing(true)}
      />
    </div>
    {overviewOpen && <QuestionOverview questionIds={questionIds} questionTypes={questionTypes} answers={answers} currentIndex={index} onClose={() => setOverviewOpen(false)} onJump={(target) => { window.clearTimeout(autoNextTimer.current); onJump(target); setOverviewOpen(false); }} />}
    {editing && <SharedQuestionEditor question={question.canonical} preferredBankId={question.bankId} onCancel={() => setEditing(false)} onSaved={() => setEditing(false)} />}
  </>;
}
