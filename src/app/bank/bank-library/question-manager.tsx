"use client";
import { useEffect, useMemo, useState } from "react";
import { FileUp, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { AppSelect } from "@/app/ui/app-select";
import { ConfirmDialog } from "@/app/ui/confirm-dialog";
import { ContentBlockRenderer } from "@/app/bank/content-block-renderer";
import { QuestionDetail } from "@/app/bank/question-detail";
import { loadImageAssetV7, QuestionEditor, SharedQuestionEditor, type QuestionChanges } from "@/app/bank/question-editor";
import { createQuestionV7, deleteQuestionsV7, removeMembershipsV7, saveNoteV7 } from "@/lib/db/db-v7";
import type { QuestionV7 } from "@/lib/db/v7-types";
import { statsNeedWrongReview, summarizeAttemptStats } from "@/lib/practice/practice-metrics";
import { DEFAULT_KEYBOARD_SHORTCUTS, normalizeKeyboardShortcuts } from "@/lib/practice/keyboard-shortcuts";
import { isQuestionDoneInScope, type ProgressScope } from "@/lib/practice/progress-scope";
import { bankTitle, PRESET_LABELS, type AttemptStats, type Bank, type Note, type Question, type QuestionPreset, type QuestionType } from "./bank-library-shared";
import { BankQuestionDeleteDialog } from "./bank-question-delete-dialog";

export function QuestionManager({ bank, questions, attemptStats, notes, roundProgress = [], progressScope = { type: "rolling", days: 90 }, progressScopeLabel = "近 90 天", preset, wrongRemovalStreak, referenceTime, onPresetChange, onImportQuestions, onNotice }: { bank: Bank; questions: Question[]; attemptStats: AttemptStats[]; notes: Note[]; roundProgress?: Array<{ key: string; roundId: string; questionId: string; attempts: number; correct: number; wrong: number; firstAttemptAt: string; latestAttemptAt: string }>; progressScope?: ProgressScope; progressScopeLabel?: string; preset: QuestionPreset; wrongRemovalStreak: number; referenceTime: number; onPresetChange: (preset: QuestionPreset) => void; onImportQuestions: () => void; onNotice: (message: string) => void }) {
  const [query, setQuery] = useState(""); const [type, setType] = useState<"全部" | QuestionType>("全部"); const [visible, setVisible] = useState(80); const [editing, setEditing] = useState<Question>(); const [viewing, setViewing] = useState<Question>(); const [adding, setAdding] = useState(false); const [pendingDelete, setPendingDelete] = useState<Question>(); const [deleting, setDeleting] = useState(false); const [selectedIds, setSelectedIds] = useState<string[]>([]); const [bulkAction, setBulkAction] = useState<"remove" | "delete">();
  const [activeQuestionId, setActiveQuestionId] = useState<string>();

  useEffect(() => {
    if (!viewing) return;
    document.querySelector(`.managed-question-list article[data-question-id="${viewing.id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [viewing]);

  const statsByQuestion = useMemo(() => new Map(attemptStats.map((stats) => [stats.questionId, stats])), [attemptStats]);
  const noteIds = useMemo(() => new Set(notes.filter((note) => note.content.trim()).map((note) => note.questionId)), [notes]);
  const navPrefs = useMemo(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("study-v7-preferences") ?? localStorage.getItem("study-v6-preferences") ?? "{}");
      return { keyboardShortcuts: normalizeKeyboardShortcuts(saved.keyboardShortcuts), swipeNavigation: saved.swipeNavigation !== false };
    } catch {
      return { keyboardShortcuts: DEFAULT_KEYBOARD_SHORTCUTS, swipeNavigation: true };
    }
  }, []);
  const filtered = useMemo(() => questions.filter((question) => {
    if (type !== "全部" && question.type !== type) return false;
    if (![question.stem, ...question.options, ...question.tags].join(" ").toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN"))) return false;
    const stats = statsByQuestion.get(question.id);
    const summary = summarizeAttemptStats(stats);
    const doneInScope = isQuestionDoneInScope(question.id, progressScope, attemptStats, roundProgress, referenceTime);
    const wrong = statsNeedWrongReview(stats, wrongRemovalStreak);
    const stale = (summary.latest ?? referenceTime) < referenceTime - 30 * 86_400_000;
    const matches: Record<QuestionPreset, boolean> = {
      all: true, attempted: doneInScope, unattempted: !doneInScope, wrong,
      favorite: Boolean(question.favorite), noted: noteIds.has(question.id), tagged: question.tags.length > 0,
      mastered: (stats?.currentCorrectStreak ?? 0) >= wrongRemovalStreak, difficult: summary.total > 0 && summary.difficulty >= 70,
      repeatWrong: summary.wrong >= 2, stubborn: summary.total >= 3 && wrong,
      favoriteUnanswered: Boolean(question.favorite) && !doneInScope,
      wrongNoted: wrong && noteIds.has(question.id), staleWrong: wrong && stale,
    };
    return matches[preset];
  }), [questions, query, type, preset, statsByQuestion, noteIds, wrongRemovalStreak, referenceTime, attemptStats, roundProgress, progressScope]);
  const visibleQuestions = filtered.slice(0, visible);
  const allFilteredSelected = filtered.length > 0 && filtered.every((question) => selectedIds.includes(question.id));
  const viewingIndex = viewing ? filtered.findIndex((question) => question.id === viewing.id) : -1;

  async function performBulkAction() {
    if (!bulkAction || !selectedIds.length) return;
    try {
      setDeleting(true);
      const count = bulkAction === "remove"
        ? await removeMembershipsV7(bank.id, selectedIds)
        : await deleteQuestionsV7(selectedIds);
      setSelectedIds([]);
      setBulkAction(undefined);
      onNotice(bulkAction === "remove" ? `已从「${bankTitle(bank)}」移除 ${count} 道题` : `已永久删除 ${count} 道题及其学习记录`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "批量处理题目失败");
    } finally {
      setDeleting(false);
    }
  }

  const blankCanonical: QuestionV7 = { id: "draft", type: "单选", content: [{ id: "stem-0", type: "text", text: "" }], options: [0, 1, 2, 3].map((index) => [{ id: `option-${index}-0`, type: "text", text: "" }]), answer: "A", tags: [], favorite: false, contentFingerprint: "0".repeat(64), updatedAt: new Date().toISOString(), deviceId: "draft" };
  return <section className="question-manager"><header><div className="question-manager-search"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setVisible(80); }} placeholder="搜索题干、选项或标签" /></div><AppSelect ariaLabel="统计条件筛选" value={preset} onValueChange={(value) => { onPresetChange(value as QuestionPreset); setVisible(80); }} options={(Object.keys(PRESET_LABELS) as QuestionPreset[]).map((value) => ({ value, label: PRESET_LABELS[value] }))} /><AppSelect ariaLabel="筛选题型" value={type} onValueChange={(value) => { setType(value as "全部" | QuestionType); setVisible(80); }} options={["全部", "单选", "多选", "判断", "计算"].map((value) => ({ value, label: value }))} /><button className="primary" onClick={() => setAdding(true)}><Plus size={16} />新增题目</button><button onClick={onImportQuestions} aria-label={`向${bankTitle(bank)}导入题目`}><FileUp size={16} />导入题目</button></header><p className="question-manager-count">当前条件：{PRESET_LABELS[preset]} · 找到 {filtered.length} 道题，当前显示 {Math.min(visible, filtered.length)} 道</p>{filtered.length > 0 && <div className="question-bulk-bar"><label><input type="checkbox" checked={allFilteredSelected} onChange={() => setSelectedIds(allFilteredSelected ? [] : filtered.map((question) => question.id))} />选择当前筛选 {filtered.length} 道</label><span>已选 {selectedIds.length} 道</span><div><button disabled={!selectedIds.length} onClick={() => setBulkAction("remove")}>从题库移除</button><button className="danger-button" disabled={!selectedIds.length} onClick={() => setBulkAction("delete")}><Trash2 size={15} />永久删除</button></div></div>}<div className="managed-question-list selectable">{visibleQuestions.map((question, index) => { const summary = summarizeAttemptStats(statsByQuestion.get(question.id)); return <article key={question.id} data-question-id={question.id} className={`${selectedIds.includes(question.id) ? "selected" : ""} ${(viewing?.id ?? activeQuestionId) === question.id ? "detail-current" : ""}`}><label className="managed-question-check"><input type="checkbox" aria-label={`选择题目 ${index + 1}`} checked={selectedIds.includes(question.id)} onChange={() => setSelectedIds(selectedIds.includes(question.id) ? selectedIds.filter((id) => id !== question.id) : [...selectedIds, question.id])} /></label><button onClick={() => { setActiveQuestionId(question.id); setViewing(question); }}><div><em>{question.type}</em>{question.tags.map((tag) => <i key={tag}>{tag}</i>)}</div><ContentBlockRenderer blocks={question.canonical.content} loadAsset={loadImageAssetV7} /><small>答案 {question.answer} · 作答 {summary.total} 次（{progressScopeLabel}） · 正确 {summary.correct} 次 · 错误 {summary.wrong} 次</small></button><div><button aria-label="编辑题目" onClick={() => setEditing(question)}><Pencil size={15} /></button><button aria-label="删除题目" onClick={() => setPendingDelete(question)}><Trash2 size={15} /></button></div></article>; })}</div>{visible < filtered.length && <button className="search-load-more" onClick={() => setVisible(visible + 80)}>继续加载（{visible} / {filtered.length}）</button>}{!filtered.length && <div className="question-manager-empty"><Search /><h3>没有符合条件的题目</h3><p>可以切换统计条件、题型或清空关键词。</p></div>}{editing && <SharedQuestionEditor question={editing.canonical} preferredBankId={bank.id} onCancel={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); onNotice("题目已保存"); }} />}{viewing && <QuestionDetail question={viewing} metric={summarizeAttemptStats(statsByQuestion.get(viewing.id))} scopeLabel={progressScopeLabel} note={notes.find((item) => item.questionId === viewing.id)?.content} onClose={() => setViewing(undefined)} footer={<><button onClick={() => { setEditing(viewing); setViewing(undefined); }}><Pencil size={16} />编辑题目</button><button onClick={() => { setPendingDelete(viewing); setViewing(undefined); }}><Trash2 size={16} />删除题目</button></>} nav={viewingIndex >= 0 ? { index: viewingIndex, total: filtered.length, onPrevious: () => { if (viewingIndex > 0) setViewing(filtered[viewingIndex - 1]); }, onNext: () => { if (viewingIndex < filtered.length - 1) setViewing(filtered[viewingIndex + 1]); }, keyboardShortcuts: navPrefs.keyboardShortcuts, swipeNavigation: navPrefs.swipeNavigation, center: <span className="search-detail-count">{viewingIndex + 1} / {filtered.length}</span> } : undefined} />}{adding && <QuestionEditor question={blankCanonical} title="新增题目" eyebrow={`添加到 ${bankTitle(bank)}`} submitLabel="添加题目" onCancel={() => setAdding(false)} onSave={async (changes: QuestionChanges, note?: string) => { const created = await createQuestionV7(bank.id, changes); if (note) await saveNoteV7(created.id, note); setAdding(false); onNotice("新题目已添加"); }} />}<BankQuestionDeleteDialog question={pendingDelete} bank={bank} busy={deleting} onClose={() => setPendingDelete(undefined)} onBusy={setDeleting} onNotice={onNotice} /><ConfirmDialog open={Boolean(bulkAction)} eyebrow="批量处理题目" title={bulkAction === "remove" ? `从题库移除 ${selectedIds.length} 道题？` : `永久删除 ${selectedIds.length} 道题？`} tone="danger" busy={deleting} confirmLabel={bulkAction === "remove" ? "批量移除" : "永久删除"} onCancel={() => setBulkAction(undefined)} onConfirm={() => void performBulkAction()} description={bulkAction === "remove" ? <><strong>题目会从“{bankTitle(bank)}”移除</strong><span>题目与学习记录仍保留；没有其他归属的题会进入“未归档题目”。</span></> : <><strong>所选题目将从所有题库永久删除</strong><span>相关作答、统计、解析、题组和练习引用也会删除，此操作不可撤销。</span></>} /></section>;
}
