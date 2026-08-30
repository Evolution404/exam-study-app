"use client";
import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowRightLeft, FileUp, Library, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { AppSelect } from "@/app/ui/app-select";
import { ConfirmDialog } from "@/app/ui/confirm-dialog";
import { ContentBlockRenderer } from "@/app/bank/content-block-renderer";
import { QuestionDetail } from "@/app/bank/question-detail";
import { loadImageAssetV7, QuestionEditor, SharedQuestionEditor, type QuestionChanges } from "@/app/bank/question-editor";
import { createQuestionV7, dbV7, deleteQuestionsV7, removeMembershipsV7, saveNoteV7 } from "@/lib/db/db-v7";
import { listQuestionMembershipViewsV7 } from "@/lib/db/app-data-v7";
import type { QuestionV7, ReviewRoundProgress } from "@/lib/db/v7-types";
import { QUESTION_TYPE_ORDER } from "@/types/types";
import { statsNeedWrongReview, summarizeAttemptStats } from "@/lib/practice/practice-metrics";
import { DEFAULT_KEYBOARD_SHORTCUTS, normalizeKeyboardShortcuts } from "@/lib/practice/keyboard-shortcuts";
import { isQuestionDoneInScope, type ProgressScope } from "@/lib/practice/progress-scope";
import { bankTitle, PRESET_LABELS, type AttemptStats, type Bank, type Note, type Question, type QuestionPreset, type QuestionType } from "./bank-library-shared";
import { BankQuestionDeleteDialog } from "./bank-question-delete-dialog";
import { BulkAddToBanksDialog, AddFromOtherBanksDialog, QuestionMembershipDialog } from "./question-membership-dialogs";
import { TagMultiSelect } from "@/app/ui/tag-multi-select";
import { matchesTagSelection, type TagMatchMode } from "@/lib/question/tag-filter";
import { solutionAnswerText } from "@/lib/question/question-utils";

type MembershipScope = "all" | "exclusive" | "shared";

export function QuestionManager({ bank, questions, attemptStats, notes, roundProgress = [], progressScope = { type: "rolling", days: 90 }, progressScopeLabel = "近 90 天", preset, wrongRemovalStreak, referenceTime, onPresetChange, onImportQuestions, onNotice }: { bank: Bank; questions: Question[]; attemptStats: AttemptStats[]; notes: Note[]; roundProgress?: ReviewRoundProgress[]; progressScope?: ProgressScope; progressScopeLabel?: string; preset: QuestionPreset; wrongRemovalStreak: number; referenceTime: number; onPresetChange: (preset: QuestionPreset) => void; onImportQuestions: () => void; onNotice: (message: string) => void }) {
  const [query, setQuery] = useState(""); const [type, setType] = useState<"全部" | QuestionType>("全部"); const [visible, setVisible] = useState(80); const [editing, setEditing] = useState<Question>(); const [viewing, setViewing] = useState<Question>(); const [adding, setAdding] = useState(false); const [pendingDelete, setPendingDelete] = useState<Question>(); const [deleting, setDeleting] = useState(false); const [selectedIds, setSelectedIds] = useState<string[]>([]); const [bulkAction, setBulkAction] = useState<"remove" | "delete">();
  const [activeQuestionId, setActiveQuestionId] = useState<string>();
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagMatch, setTagMatch] = useState<TagMatchMode>("any");
  const [membershipScope, setMembershipScope] = useState<MembershipScope>("all");
  const [membershipBankId, setMembershipBankId] = useState("all");
  const [addFromOtherOpen, setAddFromOtherOpen] = useState(false);
  const [managingMembership, setManagingMembership] = useState<Question>();
  const [bulkAddOpen, setBulkAddOpen] = useState(false);

  useEffect(() => {
    if (!viewing) return;
    document.querySelector(`.managed-question-list article[data-question-id="${viewing.id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [viewing]);

  const questionIdsKey = useMemo(() => questions.map((question) => question.id).join("|"), [questions]);
  const membershipViews = useLiveQuery(() => listQuestionMembershipViewsV7(questions.map((question) => question.id)), [questionIdsKey]) ?? [];
  const banks = useLiveQuery(() => dbV7.banks.orderBy("sortOrder").toArray(), [bank.id]) ?? [];
  const membershipByQuestion = useMemo(() => new Map(membershipViews.map((view) => [view.questionId, view])), [membershipViews]);
  const sharedCount = useMemo(() => questions.filter((question) => (membershipByQuestion.get(question.id)?.memberships.length ?? 1) > 1).length, [membershipByQuestion, questions]);
  const exclusiveCount = questions.length - sharedCount;

  const statsByQuestion = useMemo(() => new Map(attemptStats.map((stats) => [stats.questionId, stats])), [attemptStats]);
  const noteIds = useMemo(() => new Set(notes.filter((note) => note.content.trim()).map((note) => note.questionId)), [notes]);
  const availableTags = useMemo(() => [...new Set(questions.flatMap((question) => question.tags))].sort((a, b) => a.localeCompare(b, "zh-CN")), [questions]);
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
    if (!matchesTagSelection(question.tags, selectedTags, tagMatch)) return false;
    const membership = membershipByQuestion.get(question.id);
    const membershipCount = membership?.memberships.length ?? 1;
    if (membershipScope === "exclusive" && membershipCount !== 1) return false;
    if (membershipScope === "shared" && membershipCount <= 1) return false;
    if (membershipBankId !== "all" && !membership?.memberships.some((item) => item.bankId === membershipBankId)) return false;
    const membershipNames = membership?.banks.map((item) => bankTitle(item)) ?? [];
    if (![question.stem, ...question.options, ...question.tags, ...membershipNames].join(" ").toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN"))) return false;
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
  }), [questions, query, type, selectedTags, tagMatch, membershipByQuestion, membershipScope, membershipBankId, preset, statsByQuestion, noteIds, wrongRemovalStreak, referenceTime, attemptStats, roundProgress, progressScope]);
  const visibleQuestions = filtered.slice(0, visible);
  const allFilteredSelected = filtered.length > 0 && filtered.every((question) => selectedIds.includes(question.id));
  const viewingIndex = viewing ? filtered.findIndex((question) => question.id === viewing.id) : -1;
  const viewingMembership = viewing ? membershipByQuestion.get(viewing.id) : undefined;

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

  const blankCanonical: QuestionV7 = { id: "draft", type: "单选", content: [{ id: "stem-0", type: "text", text: "" }], options: [0, 1, 2, 3].map((index) => [{ id: `option-${index}-0`, type: "text", text: "" }]), optionIds: ["option-0", "option-1", "option-2", "option-3"], solution: { kind: "choice", correctOptionIds: ["option-0"] }, tags: [], favorite: false, contentFingerprint: "0".repeat(64), updatedAt: new Date().toISOString(), deviceId: "draft" };
  return <section className="question-manager"><header><div className="question-manager-search"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setVisible(80); }} placeholder="搜索题干、选项、标签或所属题库" /></div><AppSelect ariaLabel="统计条件筛选" value={preset} onValueChange={(value) => { onPresetChange(value as QuestionPreset); setVisible(80); }} options={(Object.keys(PRESET_LABELS) as QuestionPreset[]).map((value) => ({ value, label: PRESET_LABELS[value] }))} /><AppSelect ariaLabel="筛选题型" value={type} onValueChange={(value) => { setType(value as "全部" | QuestionType); setVisible(80); }} options={["全部", ...QUESTION_TYPE_ORDER].map((value) => ({ value, label: value }))} /><button className="primary" onClick={() => setAdding(true)}><Plus size={16} />新增题目</button><button className="secondary question-add-existing" onClick={() => setAddFromOtherOpen(true)}><ArrowRightLeft size={16} />从其他题库添加</button><button className="secondary" onClick={onImportQuestions} aria-label={`向${bankTitle(bank)}导入题目`}><FileUp size={16} />导入题目</button></header>
    <div className="question-membership-filterbar"><div className="question-membership-tabs" role="group" aria-label="题库归属筛选"><button className={membershipScope === "all" ? "active" : ""} onClick={() => { setMembershipScope("all"); setVisible(80); }}>全部 <span>{questions.length}</span></button><button className={membershipScope === "exclusive" ? "active" : ""} onClick={() => { setMembershipScope("exclusive"); setVisible(80); }}>仅本题库 <span>{exclusiveCount}</span></button><button className={membershipScope === "shared" ? "active" : ""} onClick={() => { setMembershipScope("shared"); setVisible(80); }}>多题库共享 <span>{sharedCount}</span></button></div><div className="question-membership-bank-filter"><Library size={15} /><AppSelect ariaLabel="按所属题库筛选" value={membershipBankId} onValueChange={(value) => { setMembershipBankId(value); setVisible(80); }} options={[{ value: "all", label: "全部所属题库" }, ...banks.filter((item) => item.id !== bank.id).map((item) => ({ value: item.id, label: bankTitle(item) }))]} /></div></div>
    <details className="question-manager-tag-filter"><summary>标签筛选{selectedTags.length ? ` · 已选 ${selectedTags.length} 个` : ""}</summary><TagMultiSelect tags={availableTags} selected={selectedTags} onChange={(next) => { setSelectedTags(next); setVisible(80); }} matchMode={tagMatch} onMatchModeChange={(next) => { setTagMatch(next); setVisible(80); }} ariaLabel="搜索题库标签" /></details><p className="question-manager-count">当前条件：{PRESET_LABELS[preset]} · {membershipScope === "shared" ? "多题库共享" : membershipScope === "exclusive" ? "仅本题库" : "全部归属"} · 找到 {filtered.length} 道题，当前显示 {Math.min(visible, filtered.length)} 道</p>{filtered.length > 0 && <div className="question-bulk-bar"><label><input type="checkbox" checked={allFilteredSelected} onChange={() => setSelectedIds(allFilteredSelected ? [] : filtered.map((question) => question.id))} />选择当前筛选 {filtered.length} 道</label><span>已选 {selectedIds.length} 道</span><div><button disabled={!selectedIds.length} onClick={() => setBulkAddOpen(true)}><Library size={15} />添加到题库</button><button disabled={!selectedIds.length} onClick={() => setBulkAction("remove")}>从当前题库移除</button><button className="danger-button" disabled={!selectedIds.length} onClick={() => setBulkAction("delete")}><Trash2 size={15} />永久删除</button></div></div>}
    <div className="managed-question-list selectable">{visibleQuestions.map((question, index) => { const summary = summarizeAttemptStats(statsByQuestion.get(question.id)); const membership = membershipByQuestion.get(question.id); const membershipCount = membership?.memberships.length ?? 1; const otherBanks = membership?.banks.filter((item) => item.id !== bank.id).map((item) => bankTitle(item)) ?? []; const membershipLabel = membershipCount > 1 ? `${membershipCount} 个题库 · ${otherBanks.slice(0, 2).join(" · ")}${otherBanks.length > 2 ? ` · +${otherBanks.length - 2}` : ""}` : "仅本题库"; return <article key={question.id} data-question-id={question.id} className={`${selectedIds.includes(question.id) ? "selected" : ""} ${(viewing?.id ?? activeQuestionId) === question.id ? "detail-current" : ""}`}><label className="managed-question-check"><input type="checkbox" aria-label={`选择题目 ${index + 1}`} checked={selectedIds.includes(question.id)} onChange={() => setSelectedIds(selectedIds.includes(question.id) ? selectedIds.filter((id) => id !== question.id) : [...selectedIds, question.id])} /></label><button onClick={() => { setActiveQuestionId(question.id); setViewing(question); }}><div><em>{question.type}</em>{question.tags.map((tag) => <i key={tag}>{tag}</i>)}</div><ContentBlockRenderer blocks={question.canonical.content} loadAsset={loadImageAssetV7} /><div className={`managed-question-membership ${membershipCount > 1 ? "shared" : ""}`}><Library size={13} /><span>{membershipLabel}</span></div><small>答案 {solutionAnswerText(question.solution, question.optionIds ?? [])} · 作答 {summary.total} 次（{progressScopeLabel}） · 正确 {summary.correct} 次 · 错误 {summary.wrong} 次</small></button><div><button aria-label="管理所属题库" onClick={() => setManagingMembership(question)}><Library size={15} /></button><button aria-label="编辑题目" onClick={() => setEditing(question)}><Pencil size={15} /></button><button aria-label="删除题目" onClick={() => setPendingDelete(question)}><Trash2 size={15} /></button></div></article>; })}</div>{visible < filtered.length && <button className="search-load-more" onClick={() => setVisible(visible + 80)}>继续加载（{visible} / {filtered.length}）</button>}{!filtered.length && <div className="question-manager-empty"><Search /><h3>没有符合条件的题目</h3><p>可以切换统计条件、题型、所属题库、标签或清空关键词。</p></div>}
    {editing && <SharedQuestionEditor question={editing.canonical} preferredBankId={bank.id} onCancel={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); onNotice("题目已保存"); }} />}
    {viewing && <QuestionDetail question={viewing} metric={summarizeAttemptStats(statsByQuestion.get(viewing.id))} scopeLabel={progressScopeLabel} note={notes.find((item) => item.questionId === viewing.id)?.content} onClose={() => setViewing(undefined)} metadata={<section className="question-detail-memberships"><div><strong>所属题库</strong><small>{(viewingMembership?.memberships.length ?? 1) > 1 ? `${viewingMembership?.memberships.length} 个题库共同使用` : "仅本题库"}</small></div><div>{(viewingMembership?.banks ?? [bank]).map((item) => <span key={item.id}>{bankTitle(item)}{item.id === bank.id ? " · 当前" : ""}</span>)}</div></section>} footer={<><button onClick={() => setManagingMembership(viewing)}><Library size={16} />管理所属题库</button><button onClick={() => { setEditing(viewing); setViewing(undefined); }}><Pencil size={16} />编辑题目</button><button onClick={() => { setPendingDelete(viewing); setViewing(undefined); }}><Trash2 size={16} />删除题目</button></>} nav={viewingIndex >= 0 ? { index: viewingIndex, total: filtered.length, onPrevious: () => { if (viewingIndex > 0) setViewing(filtered[viewingIndex - 1]); }, onNext: () => { if (viewingIndex < filtered.length - 1) setViewing(filtered[viewingIndex + 1]); }, keyboardShortcuts: navPrefs.keyboardShortcuts, swipeNavigation: navPrefs.swipeNavigation, center: <span className="search-detail-count">{viewingIndex + 1} / {filtered.length}</span> } : undefined} />}
    {adding && <QuestionEditor question={blankCanonical} title="新增题目" eyebrow={`添加到 ${bankTitle(bank)}`} submitLabel="添加题目" onCancel={() => setAdding(false)} onSave={async (changes: QuestionChanges, note?: string) => { const created = await createQuestionV7(bank.id, changes); if (note) await saveNoteV7(created.id, note); setAdding(false); onNotice("新题目已添加"); }} />}
    {addFromOtherOpen && <AddFromOtherBanksDialog bank={bank} onClose={() => setAddFromOtherOpen(false)} onAdded={(count) => onNotice(count ? `已将 ${count} 道已有题目加入「${bankTitle(bank)}」` : "所选题目已在当前题库中")} onNotice={onNotice} />}
    {managingMembership && <QuestionMembershipDialog questionId={managingMembership.id} currentBankId={bank.id} onClose={() => setManagingMembership(undefined)} onSaved={(result) => { setViewing(undefined); setSelectedIds((current) => current.filter((id) => id !== managingMembership.id)); onNotice(`所属题库已更新：新增 ${result.added} 个，移除 ${result.removed} 个`); }} onNotice={onNotice} />}
    {bulkAddOpen && <BulkAddToBanksDialog currentBankId={bank.id} questionIds={selectedIds} onClose={() => setBulkAddOpen(false)} onAdded={(count, bankCount) => { setSelectedIds([]); onNotice(`已向 ${bankCount} 个题库新增 ${count} 条题目归属`); }} onNotice={onNotice} />}
    <BankQuestionDeleteDialog question={pendingDelete} bank={bank} busy={deleting} onClose={() => setPendingDelete(undefined)} onBusy={setDeleting} onNotice={onNotice} /><ConfirmDialog open={Boolean(bulkAction)} eyebrow="批量处理题目" title={bulkAction === "remove" ? `从题库移除 ${selectedIds.length} 道题？` : `永久删除 ${selectedIds.length} 道题？`} tone="danger" busy={deleting} confirmLabel={bulkAction === "remove" ? "批量移除" : "永久删除"} onCancel={() => setBulkAction(undefined)} onConfirm={() => void performBulkAction()} description={bulkAction === "remove" ? <><strong>题目会从“{bankTitle(bank)}”移除</strong><span>题目与学习记录仍保留；没有其他归属的题会进入“未归档题目”。</span></> : <><strong>所选题目将从所有题库永久删除</strong><span>相关作答、统计、解析、题组和练习引用也会删除，此操作不可撤销。</span></>} /></section>;
}
