"use client";
import { ChevronLeft, ChevronRight, CircleHelp, Grid3X3, NotebookPen, Pencil, RefreshCw, Star, X } from "lucide-react";
import { difficultyLabel, difficultyTone, type AttemptSummary } from "@/lib/practice/practice-metrics";
import { formatKeyboardShortcut } from "@/lib/practice/keyboard-shortcuts";
import type { AttemptOutcome } from "@/lib/db/v7-types";
import type { PracticePreferences, Question, QuestionType } from "../helpers";
import { Hint } from "@/app/ui/hint";
import { NoteMarkdown } from "@/app/ui/note-markdown";
import { QuestionCopyAction } from "@/app/ui/question-copy-action";

type CopyStatus = "idle" | "copied" | "error";

export function PracticeHeader({ index, total, modeLabel, onExit, onOpenOverview }: { index: number; total: number; modeLabel: string; onExit: () => void; onOpenOverview: () => void }) {
  return <div className="practice-head">
    <button className="icon-button" aria-label="暂停并返回首页" onClick={onExit}><X size={19} /></button>
    <div className="practice-progress"><span>{index + 1} / {total} · {modeLabel}</span><i><b style={{ width: `${(index + 1) / total * 100}%` }} /></i></div>
    <div className="practice-head-actions"><button className="icon-button overview-trigger" aria-label="打开题目总览" onClick={onOpenOverview}><Grid3X3 size={18} /></button></div>
  </div>;
}

export function PracticeQuestionHeading({ question, attemptSummary, submitted, copyQuestionStatus, copyAnswerStatus, onCopyQuestion, onCopyQuestionWithAnswer, onFavorite, onEdit }: { question: Question; attemptSummary: AttemptSummary; submitted: boolean; copyQuestionStatus: CopyStatus; copyAnswerStatus: CopyStatus; onCopyQuestion: () => void; onCopyQuestionWithAnswer: () => void; onFavorite: () => void; onEdit: () => void }) {
  return <div className="question-heading">
    <div className="question-source">{question.bankName}</div>
    <div className="question-meta">
      <em className="question-type-chip">{question.type}</em>
      <Hint label="个人难度按有效作答时间与作答间隔动态估计：明显快于自己常态、且间隔够久（约半天以上）的做对才显著降低难度；做错会立即推高难度。"><em className={`difficulty-chip difficulty-${difficultyTone(attemptSummary.difficulty)}`}>个人难度 {attemptSummary.difficulty} · {difficultyLabel(attemptSummary.difficulty)}</em></Hint>
      {question.tags.map((tag) => <em key={tag}>{tag}</em>)}
    </div>
    <div className="question-tools">
      <QuestionCopyAction status={copyQuestionStatus} onClick={onCopyQuestion} />
      {submitted && <QuestionCopyAction includeAnswer status={copyAnswerStatus} onClick={onCopyQuestionWithAnswer} />}
      <button type="button" className={`question-tool favorite ${question.favorite ? "active" : ""}`} aria-label={question.favorite ? "取消收藏" : "收藏题目"} aria-pressed={Boolean(question.favorite)} onClick={onFavorite}><Star size={14} fill={question.favorite ? "currentColor" : "none"} />{question.favorite ? "已收藏" : "收藏"}</button>
      <button type="button" className="question-tool edit" onClick={onEdit}><Pencil size={14} />编辑题目</button>
    </div>
  </div>;
}

export function PracticeResultSummary({ submitted, correct, questionType, shortOutcome, autoAdvancing, gaveUp, displayAnswer, selectedAnswer, showAnswerOnWrong, attemptSummary }: { submitted: boolean; correct: boolean; questionType: QuestionType; shortOutcome?: AttemptOutcome; autoAdvancing: boolean; gaveUp: boolean; displayAnswer: string; selectedAnswer: string; showAnswerOnWrong: boolean; attemptSummary: AttemptSummary }) {
  if (!submitted) return null;
  return <>
    <div className={`result-box ${correct ? "success" : "error"}`}>
      {questionType === "简答" ? <><strong>{shortOutcome === "correct" ? (autoAdvancing ? "已标记正确，即将进入下一题" : "已标记正确") : shortOutcome === "skipped" ? "已跳过，并计入错题" : "已标记错误"}</strong><p>本题按自评记录，参考答案见上方。</p></> : <><strong>{correct ? (autoAdvancing ? "回答正确，即将进入下一题" : "回答正确") : gaveUp ? "已标记为不会，并计入错题" : "这次没有答对"}</strong>{correct ? <p>正确答案：{displayAnswer}</p> : showAnswerOnWrong ? <p>正确答案：{displayAnswer}｜你的选择：{selectedAnswer || "不会"}</p> : <p>正确答案已按配置隐藏｜你的选择：{selectedAnswer || "不会"}</p>}</>}
    </div>
    <div className="attempt-summary"><span><strong>{attemptSummary.total}</strong>总作答</span><span className="correct"><strong>{attemptSummary.correct}</strong>正确</span><span className="wrong"><strong>{attemptSummary.wrong}</strong>错误</span><span className={`difficulty difficulty-${difficultyTone(attemptSummary.difficulty)}`}><strong>{attemptSummary.difficulty}</strong>个人难度 · {difficultyLabel(attemptSummary.difficulty)}</span></div>
  </>;
}

export function PracticeNavigationHints({ preferences }: { preferences: PracticePreferences }) {
  return <>
    {preferences.keyboardShortcuts.enabled && <div className="keyboard-hint">快捷键：确认 <kbd>{preferences.keyboardShortcuts.bindings.confirm.map(formatKeyboardShortcut).join(" / ") || "未设置"}</kbd> · 上一题 <kbd>{preferences.keyboardShortcuts.bindings.previous.map(formatKeyboardShortcut).join(" / ") || "未设置"}</kbd> · 下一题 <kbd>{preferences.keyboardShortcuts.bindings.next.map(formatKeyboardShortcut).join(" / ") || "未设置"}</kbd></div>}
    {preferences.swipeNavigation && <div className="swipe-hint"><ChevronLeft size={15} />右滑上一题 · 左滑下一题<ChevronRight size={15} /></div>}
  </>;
}

export function PracticeActionBar({ submitted, correct, questionType, preferences, selectedCount, shortHasAnswer, calculationInputValid, fillInputValid, autoAdvancing, index, isLast, onPrevious, onGiveUp, onSubmit, onGrade, onRetry, onFinish, onNext }: { submitted: boolean; correct: boolean; questionType: QuestionType; preferences: PracticePreferences; selectedCount: number; shortHasAnswer: boolean; calculationInputValid: boolean; fillInputValid: boolean; autoAdvancing: boolean; index: number; isLast: boolean; onPrevious: () => void; onGiveUp: () => void; onSubmit: () => void; onGrade: (outcome: AttemptOutcome) => void; onRetry: () => void; onFinish: () => void; onNext: () => void }) {
  const submitDisabled = questionType === "计算" ? !calculationInputValid : questionType === "填空" ? !fillInputValid : selectedCount === 0;
  return <div className={`practice-actions ${submitted ? "submitted" : ""} ${submitted && !correct && preferences.wrongReappearance === "immediate" ? "with-retry" : ""}`}>
    <button className="secondary practice-previous" onClick={onPrevious} disabled={index === 0}><ChevronLeft size={18} />上一题</button>
    <div>
      {!submitted && <button className="dont-know-action" onClick={onGiveUp}><CircleHelp size={17} />不会</button>}
      {!submitted && questionType !== "多选" && questionType !== "计算" && questionType !== "填空" && questionType !== "简答" && preferences.submitOnSelect && <span className="answer-action-hint">选择答案后立即判定</span>}
      {!submitted && (questionType === "计算" || questionType === "多选" || questionType === "填空" || (!preferences.submitOnSelect && questionType !== "简答")) && <button className="primary practice-submit" disabled={submitDisabled} onClick={onSubmit}>确认答案</button>}
      {!submitted && questionType === "简答" && <div className="short-grade-actions"><button className="secondary" disabled={!shortHasAnswer} onClick={() => onGrade("correct")}>标记正确</button><button className="secondary" disabled={!shortHasAnswer} onClick={() => onGrade("incorrect")}>标记错误</button><button className="secondary" disabled={!shortHasAnswer} onClick={() => onGrade("skipped")}>跳过</button></div>}
      {submitted && !correct && preferences.wrongReappearance === "immediate" && <button className="secondary retry-question" onClick={onRetry}><RefreshCw size={16} />立即重答</button>}
      {autoAdvancing ? <span className="answer-action-hint practice-auto-status">正在自动前进…</span> : <button className="practice-next" onClick={isLast ? onFinish : onNext}>{isLast ? "查看本次结果" : "下一题"}<ChevronRight size={18} /></button>}
    </div>
  </div>;
}

export function PracticeNotePanel({ submitted, editing, draft, saveStatus, onStartEditing, onStopEditing, onChange, onEditQuestion }: { submitted: boolean; editing: boolean; draft: string; saveStatus: "idle" | "saving" | "saved"; onStartEditing: () => void; onStopEditing: () => void; onChange: (value: string) => void; onEditQuestion: () => void }) {
  if (!submitted) return null;
  return <aside className="note-panel">
    <div><NotebookPen size={18} /><strong>我的解析</strong></div>
    {!editing && draft.trim() ? <div className="note-panel-view" role="button" tabIndex={0} aria-label="编辑解析，支持 Markdown 与 LaTeX" onClick={onStartEditing} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onStartEditing(); } }}><NoteMarkdown text={draft} /></div> : <textarea value={draft} onChange={(event) => onChange(event.target.value)} onFocus={onStartEditing} onBlur={() => { if (draft.trim()) onStopEditing(); }} placeholder="写下错因、口诀或区分条件…（支持 Markdown 与 LaTeX）" />}
    <span className={`note-save-status ${saveStatus}`}>{saveStatus === "saving" ? "正在自动保存…" : saveStatus === "saved" ? "已自动保存" : "输入后自动保存"}</span>
    <button className="edit-question-button" onClick={onEditQuestion}><Pencil size={15} />编辑题目与标签</button>
    <small>切换题目或离开页面前会自动保存解析。</small>
  </aside>;
}
