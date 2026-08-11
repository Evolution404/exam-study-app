"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, BarChart3, BookOpenCheck, Bookmark,
  CalendarClock, CheckCircle2, ChevronRight, Clock3, Edit3, FileText, FileUp, Folder,
  FolderOpen, FolderPlus, Gauge, GripVertical, History, Library, NotebookPen, Pencil,
  Plus, Search, Tag, Target, Trash2, X,
} from "lucide-react";
import { loadImageAssetV6, QuestionEditor, SharedQuestionEditor, toQuestionViewModel, type QuestionChanges, type QuestionViewModel } from "@/app/question-editor";
import { ExcelImportActions } from "@/app/excel-import";
import { AppSelect } from "@/app/app-select";
import { ConfirmDialog } from "@/app/confirm-dialog";
import { ModalPortal } from "@/app/modal-portal";
import { createQuestionV6, dbV6, deleteBankFolderV6, deleteBankV6, deleteQuestionV6, removeMembershipV6, reorderBanksV6, saveBankFolderV6, updateBankV6 } from "@/lib/db-v6";
import { listQuestionViewsForBankV6, listUnfiledQuestionsV6 } from "@/lib/app-data-v6";
import type { AttemptStatsV6, BankFolderV6, BankV6, NoteV6, PracticeRunV6, QuestionV6, QuestionTypeV6 } from "@/lib/v6-types";
import { calendarDate, statsNeedWrongReview, summarizeAttemptStats } from "@/lib/practice-metrics";
import { buildScopedQuestionStats, isQuestionDoneInScope, normalizeProgressScope, summarizeScopedQuestionStats, type ProgressScope } from "@/lib/progress-scope";
import { ContentBlockRenderer } from "@/app/content-block-renderer";
type Bank = BankV6;
type BankFolder = BankFolderV6;
type Question = QuestionViewModel;
type QuestionType = QuestionTypeV6;
type Note = NoteV6;
type PracticeRun = PracticeRunV6;
type AttemptStats = AttemptStatsV6 & { bankId: string };

async function reorderBanks(ids: string[], folderId?: string) { await reorderBanksV6(ids, folderId); }
async function saveBank(id: string, changes: Partial<Pick<BankV6, "name" | "displayName" | "description" | "color" | "folderId" | "sortOrder">>) { return updateBankV6(id, changes); }
async function saveBankFolder(input: Partial<BankFolder>): Promise<BankFolder> { return saveBankFolderV6({ id: input.id, name: input.name?.trim() || "未命名文件夹", description: input.description ?? "" }); }
async function deleteBankFolder(id: string): Promise<void> { await deleteBankFolderV6(id); }

export type BankQuickMode = "random30" | "sequential" | "randomAll" | "wrong" | "favorite" | "difficult";

function bankTitle(bank: Bank) { return bank.displayName?.trim() || bank.name; }
function fullDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function sortedBanks(banks: Bank[]) { return [...banks].sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.importedAt.localeCompare(b.importedAt)); }

type QuestionPreset = "all" | "attempted" | "unattempted" | "wrong" | "favorite" | "noted" | "tagged" | "mastered" | "difficult" | "repeatWrong" | "stubborn" | "favoriteUnanswered" | "wrongNoted" | "staleWrong";
type ActivityRange = 1 | 7 | 30 | "custom";

const PRESET_LABELS: Record<QuestionPreset, string> = {
  all: "全部题目", attempted: "已做题目", unattempted: "未做题目", wrong: "当前错题",
  favorite: "收藏题目", noted: "有解析题目", tagged: "有标签题目", mastered: "已掌握题目",
  difficult: "高难题", repeatWrong: "错两次及以上", stubborn: "反复出错", favoriteUnanswered: "收藏但未做",
  wrongNoted: "错题且有解析", staleWrong: "30 天未复习错题",
};

function percent(part: number, total: number) { return total ? Math.round(part / total * 100) : 0; }
function formatDateTime(value?: string) {
  if (!value) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
function formatDuration(ms: number) {
  if (!ms) return "0 分钟";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`;
}
function runAnswered(run: PracticeRun) { return Object.values(run.answers).filter((answer) => answer.submitted).length; }
function runAccuracy(run: PracticeRun) {
  const answered = Object.values(run.answers).filter((answer) => answer.submitted);
  return percent(answered.filter((answer) => answer.correct).length, answered.length);
}

export function BankLibraryView({ banks, progressScope = { type: "rolling", days: 90 }, progressScopeLabel = "近 90 天", wrongRemovalStreak, onImport, onOpenRun, onNotice }: { banks: Bank[]; progressScope?: ProgressScope; progressScopeLabel?: string; wrongRemovalStreak: number; onImport: () => void; onOpenRun: (runId: string) => void; onNotice: (message: string) => void }) {
  const folders = useLiveQuery(() => dbV6.bankFolders.orderBy("sortOrder").toArray(), []) ?? [];
  const [activeBankId, setActiveBankId] = useState<string>();
  const [tab, setTab] = useState<"overview" | "questions">("overview");
  const [editingBank, setEditingBank] = useState<Bank>();
  const [folderDialog, setFolderDialog] = useState<BankFolder | "new">();
  const [draggedBankId, setDraggedBankId] = useState<string>();
  const [pendingBankDelete, setPendingBankDelete] = useState<Bank>();
  const [pendingFolderDelete, setPendingFolderDelete] = useState<BankFolder>();
  const [deleting, setDeleting] = useState(false);
  const [showUnfiled, setShowUnfiled] = useState(false);
  const ordered = sortedBanks(banks);
  const activeBank = banks.find((bank) => bank.id === activeBankId);
  const unfiledQuestions = useLiveQuery(() => showUnfiled ? listUnfiledQuestionsV6() : Promise.resolve([]), [showUnfiled]) ?? [];

  async function placeBank(bankId: string, folderId: string | undefined, beforeId?: string) {
    const members = sortedBanks(banks.filter((bank) => bank.folderId === folderId && bank.id !== bankId));
    const index = beforeId ? Math.max(0, members.findIndex((bank) => bank.id === beforeId)) : members.length;
    members.splice(index < 0 ? members.length : index, 0, banks.find((bank) => bank.id === bankId)!);
    await reorderBanks(members.map((bank) => bank.id), folderId);
    setDraggedBankId(undefined);
  }

  function moveBank(bank: Bank, offset: number) {
    const members = sortedBanks(banks.filter((item) => item.folderId === bank.folderId));
    const index = members.findIndex((item) => item.id === bank.id);
    const target = index + offset;
    if (target < 0 || target >= members.length) return;
    [members[index], members[target]] = [members[target], members[index]];
    void reorderBanks(members.map((item) => item.id), bank.folderId);
  }

  async function removeBank(bank: Bank) {
    try {
      setDeleting(true);
      await deleteBankV6(bank.id);
      setActiveBankId(undefined); setTab("overview"); setPendingBankDelete(undefined);
      onNotice(`题库“${bankTitle(bank)}”已删除`);
    } finally { setDeleting(false); }
  }

  if (activeBank) return <><BankDetail bank={activeBank} folders={folders} progressScope={progressScope} progressScopeLabel={progressScopeLabel} tab={tab} wrongRemovalStreak={wrongRemovalStreak} onTab={setTab} onBack={() => { setActiveBankId(undefined); setTab("overview"); }} onEdit={() => setEditingBank(activeBank)} onDelete={() => setPendingBankDelete(activeBank)} onOpenRun={onOpenRun} onNotice={onNotice} />{editingBank && <BankEditDialog bank={editingBank} folders={folders} onClose={() => setEditingBank(undefined)} onSaved={(name) => { setEditingBank(undefined); onNotice(`题库“${name}”已保存`); }} />}<ConfirmDialog open={Boolean(pendingBankDelete)} eyebrow="题库管理" title="移除这个题库？" tone="danger" busy={deleting} confirmLabel="移除题库" onCancel={() => setPendingBankDelete(undefined)} onConfirm={() => { if (pendingBankDelete) void removeBank(pendingBankDelete); }} description={<><strong>题库“{pendingBankDelete ? bankTitle(pendingBankDelete) : ""}”及其 memberships 将被移除</strong><span>题目本身、历史作答和解析会保留；失去全部题库归属的题目可在“未归档题目”中找回。</span></>} /></>;
  return <>
    <div className="page-heading compact bank-management-heading"><div><p className="eyebrow">资料资产管理</p><h1>题库管理</h1><p>拖动调整顺序，用文件夹聚合题库；做题请前往练习中心。</p></div><div className="heading-actions"><button onClick={() => setFolderDialog("new")}><FolderPlus size={17} />新建文件夹</button><button onClick={() => setShowUnfiled((value) => !value)}>{showUnfiled ? "隐藏未归档" : "未归档题目"}</button><ExcelImportActions onNotice={onNotice} /><button className="primary" onClick={onImport}><FileUp size={17} />导入 JSON</button></div></div>
    {showUnfiled && <UnfiledQuestionSection questions={unfiledQuestions} onNotice={onNotice} />}
    {banks.length ? <div className="bank-folder-list">
      {folders.map((folder) => <BankFolderSection key={folder.id} folder={folder} banks={ordered.filter((bank) => bank.folderId === folder.id)} draggedBankId={draggedBankId} onDrag={setDraggedBankId} onDrop={(beforeId) => draggedBankId && void placeBank(draggedBankId, folder.id, beforeId)} onOpen={(bank) => setActiveBankId(bank.id)} onMove={moveBank} onEditFolder={() => setFolderDialog(folder)} onDeleteFolder={() => setPendingFolderDelete(folder)} />)}
      <BankFolderSection banks={ordered.filter((bank) => !bank.folderId || !folders.some((folder) => folder.id === bank.folderId))} draggedBankId={draggedBankId} onDrag={setDraggedBankId} onDrop={(beforeId) => draggedBankId && void placeBank(draggedBankId, undefined, beforeId)} onOpen={(bank) => setActiveBankId(bank.id)} onMove={moveBank} />
    </div> : <button className="empty-import" onClick={onImport}><span><FileUp size={22} /></span><div><strong>导入 JSON 题库</strong><small>也可以使用页面上方的 Excel 模板导入</small></div><ChevronRight size={18} /></button>}
    {editingBank && <BankEditDialog bank={editingBank} folders={folders} onClose={() => setEditingBank(undefined)} onSaved={(name) => { setEditingBank(undefined); onNotice(`题库“${name}”已保存`); }} />}
    {folderDialog && <FolderDialog folder={folderDialog === "new" ? undefined : folderDialog} onClose={() => setFolderDialog(undefined)} onSaved={(name) => { setFolderDialog(undefined); onNotice(`文件夹“${name}”已保存`); }} />}
    <ConfirmDialog open={Boolean(pendingFolderDelete)} eyebrow="题库分组" title="删除这个文件夹？" tone="danger" busy={deleting} confirmLabel="删除文件夹" onCancel={() => setPendingFolderDelete(undefined)} onConfirm={async () => { if (!pendingFolderDelete) return; try { setDeleting(true); await deleteBankFolder(pendingFolderDelete.id); setPendingFolderDelete(undefined); onNotice("文件夹已删除，题库已移到未分组"); } finally { setDeleting(false); } }} description={<><strong>文件夹“{pendingFolderDelete?.name}”会被删除</strong><span>其中的题库会移到“未分组”，题库和学习记录不会被删除。</span></>} />
  </>;
}

function UnfiledQuestionSection({ questions, onNotice }: { questions: QuestionV6[]; onNotice: (message: string) => void }) {
  const [editing, setEditing] = useState<QuestionV6>();
  const models = questions.map((question) => toQuestionViewModel(question));
  return <section className="unfiled-question-section"><header><div><span className="section-kicker">全局题目仍保留</span><h2>未归档题目</h2><p>这些题目暂时没有任何题库 membership；历史作答和解析不会被自动删除。</p></div><strong>{questions.length} 道题</strong></header>{models.length ? <div className="managed-question-list">{models.map((question) => <article key={question.id}><span>·</span><button onClick={() => setEditing(question.canonical)}><ContentBlockRenderer blocks={question.canonical.content} loadAsset={loadImageAssetV6} /><small>{question.type} · {question.tags.join("、") || "无标签"}</small></button></article>)}</div> : <p className="question-manager-empty">暂无未归档题目。</p>}{editing && <SharedQuestionEditor question={editing} onCancel={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); onNotice("未归档题目已保存"); }} />}</section>;
}

function BankFolderSection({ folder, banks, draggedBankId, onDrag, onDrop, onOpen, onMove, onEditFolder, onDeleteFolder }: { folder?: BankFolder; banks: Bank[]; draggedBankId?: string; onDrag: (id?: string) => void; onDrop: (beforeId?: string) => void; onOpen: (bank: Bank) => void; onMove: (bank: Bank, offset: number) => void; onEditFolder?: () => void; onDeleteFolder?: () => void }) {
  return <section className={`bank-folder ${draggedBankId ? "drag-active" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onDrop(); }}><header><span className="folder-icon">{folder ? <FolderOpen size={18} /> : <Library size={18} />}</span><div><h2>{folder?.name ?? "未分组"}</h2><p>{folder?.description || `${banks.length} 个题库`}</p></div><strong>{banks.length}</strong>{folder && <div className="folder-actions"><button aria-label={`编辑文件夹${folder.name}`} onClick={onEditFolder}><Pencil size={15} /></button><button aria-label={`删除文件夹${folder.name}`} onClick={onDeleteFolder}><Trash2 size={15} /></button></div>}</header><div className="bank-management-grid">{banks.map((bank, index) => <article key={bank.id} draggable onDragStart={() => onDrag(bank.id)} onDragEnd={() => onDrag(undefined)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); event.preventDefault(); onDrop(bank.id); }}><span className="bank-drag"><GripVertical size={18} /></span><button className="bank-management-main" onClick={() => onOpen(bank)}><span className="bank-color" style={{ background: bank.color || "#dfe9e2" }}><BookOpenCheck size={18} /></span><span><strong>{bankTitle(bank)}</strong><small>{bank.questionCount.toLocaleString()} 题 · {fullDate(bank.importedAt)}</small></span><ChevronRight size={17} /></button><div className="bank-order-buttons"><button aria-label="向上移动" disabled={index === 0} onClick={() => onMove(bank, -1)}><ArrowUp size={14} /></button><button aria-label="向下移动" disabled={index === banks.length - 1} onClick={() => onMove(bank, 1)}><ArrowDown size={14} /></button></div></article>)}</div>{!banks.length && <div className="folder-drop-empty"><Folder size={20} />将题库拖到这里</div>}</section>;
}

function BankDetail({ bank, folders, progressScope, progressScopeLabel, tab, wrongRemovalStreak, onTab, onBack, onEdit, onDelete, onOpenRun, onNotice }: { bank: Bank; folders: BankFolder[]; progressScope: ProgressScope; progressScopeLabel: string; tab: "overview" | "questions"; wrongRemovalStreak: number; onTab: (tab: "overview" | "questions") => void; onBack: () => void; onEdit: () => void; onDelete: () => void; onOpenRun: (runId: string) => void; onNotice: (message: string) => void }) {
  const [questionPreset, setQuestionPreset] = useState<QuestionPreset>("all");
  const [activityRange, setActivityRange] = useState<ActivityRange>(7);
  const [referenceTime] = useState(Date.now);
  const defaultCustomFrom = new Date(referenceTime);
  defaultCustomFrom.setDate(defaultCustomFrom.getDate() - 6);
  const [customActivityRange, setCustomActivityRange] = useState({ from: calendarDate(defaultCustomFrom), to: calendarDate(new Date(referenceTime)) });
  const dataset = useLiveQuery(async () => {
    const views = await listQuestionViewsForBankV6(bank.id);
    const questions = views.map((view) => toQuestionViewModel(view.question, bank.id, bankTitle(bank), view.memberships[0]?.sortOrder ?? 0));
    const questionIds = new Set(questions.map((question) => question.id));
    const [rawStats, rawAttempts, allNotes, allRuns, runStats, roundProgress] = await Promise.all([
      dbV6.attemptStats.toArray(),
      dbV6.attempts.toArray(),
      dbV6.notes.toArray(),
      dbV6.practiceRuns.toArray(),
      dbV6.practiceRunStats.get(bank.id),
      dbV6.reviewRoundProgress.toArray(),
    ]);
    const attemptStats = rawStats.filter((stats) => questionIds.has(stats.questionId)).map((stats) => ({ ...stats, bankId: bank.id }));
    return { questions, lifetimeAttemptStats: attemptStats, attempts: rawAttempts.filter((attempt) => questionIds.has(attempt.questionId)), notes: allNotes.filter((note) => questionIds.has(note.questionId) && note.content.trim()), runs: allRuns.filter((run) => run.bankId === bank.id || run.bankIds.includes(bank.id)), runStats, roundProgress: roundProgress.filter((row) => questionIds.has(row.questionId)) };
  }, [bank.id]);
  const questions = useMemo(() => dataset?.questions ?? [], [dataset]);
  const lifetimeAttemptStats = useMemo(() => dataset?.lifetimeAttemptStats ?? [], [dataset]);
  const attempts = useMemo(() => dataset?.attempts ?? [], [dataset]);
  const notes = useMemo(() => dataset?.notes ?? [], [dataset]);
  const runs = useMemo(() => dataset?.runs ?? [], [dataset]);
  const runStats = dataset?.runStats;
  const roundProgress = useMemo(() => dataset?.roundProgress ?? [], [dataset?.roundProgress]);
  const normalizedScope = useMemo(() => normalizeProgressScope(progressScope), [progressScope]);
  const scopedStatsByQuestion = useMemo(() => buildScopedQuestionStats(questions.map((question) => question.id), normalizedScope, attempts, roundProgress, referenceTime), [questions, normalizedScope, attempts, roundProgress, referenceTime]);
  const attemptStats = useMemo<AttemptStats[]>(() => [...scopedStatsByQuestion.values()].map((stats) => ({
    ...stats, bankId: bank.id, giveUps: stats.giveUps ?? 0, totalElapsedMs: stats.totalElapsedMs ?? 0,
    firstAttemptCorrect: stats.firstAttemptCorrect ?? false, recentOutcomes: [],
  })), [bank.id, scopedStatsByQuestion]);
  const statsByQuestion = useMemo(() => new Map(attemptStats.map((stats) => [stats.questionId, stats])), [attemptStats]);
  const dashboard = useMemo(() => {
    const noteIds = new Set(notes.map((note) => note.questionId));
    const summaries = new Map(questions.map((question) => [question.id, summarizeAttemptStats(statsByQuestion.get(question.id))]));
    const attempted = questions.filter((question) => isQuestionDoneInScope(question.id, normalizedScope, attemptStats, roundProgress, referenceTime));
    const doneByQuestion = new Map(questions.map((question) => [question.id, isQuestionDoneInScope(question.id, normalizedScope, attemptStats, roundProgress, referenceTime)]));
    const wrong = questions.filter((question) => statsNeedWrongReview(statsByQuestion.get(question.id), wrongRemovalStreak));
    const mastered = questions.filter((question) => (statsByQuestion.get(question.id)?.currentCorrectStreak ?? 0) >= wrongRemovalStreak);
    const types = Object.fromEntries((["单选", "多选", "判断", "计算"] as QuestionType[]).map((type) => [type, questions.filter((question) => question.type === type).length])) as Record<QuestionType, number>;
    const difficulty = { easy: 0, medium: 0, hard: 0 };
    attempted.forEach((question) => {
      const score = summaries.get(question.id)?.difficulty ?? 0;
      if (score >= 70) difficulty.hard += 1;
      else if (score >= 45) difficulty.medium += 1;
      else difficulty.easy += 1;
    });
    const tagMap = new Map<string, Question[]>();
    questions.forEach((question) => question.tags.forEach((tag) => tagMap.set(tag, [...(tagMap.get(tag) ?? []), question])));
    const tags = [...tagMap.entries()].map(([name, tagged]) => {
      const taggedStats = tagged.map((question) => statsByQuestion.get(question.id)).filter((stats): stats is AttemptStats => Boolean(stats));
      const taggedWrong = tagged.filter((question) => statsNeedWrongReview(statsByQuestion.get(question.id), wrongRemovalStreak)).length;
      const totals = taggedStats.reduce((result, stats) => ({ total: result.total + stats.total, correct: result.correct + stats.correct }), { total: 0, correct: 0 });
      return { name, count: tagged.length, wrong: taggedWrong, accuracy: percent(totals.correct, totals.total) };
    }).sort((a, b) => b.wrong - a.wrong || b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
    const orderedRuns = [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const activityTo = activityRange === "custom" ? customActivityRange.to : calendarDate(new Date(referenceTime));
    const activityFrom = (() => {
      if (activityRange === "custom") return customActivityRange.from;
      const cutoff = new Date(referenceTime);
      cutoff.setHours(0, 0, 0, 0);
      cutoff.setDate(cutoff.getDate() - (activityRange - 1));
      return calendarDate(cutoff);
    })();
    const rangeAttempts = attempts.filter((attempt) => {
      const date = calendarDate(attempt.createdAt);
      return activityFrom <= activityTo && date >= activityFrom && date <= activityTo;
    });
    const activeQuestionIds = new Set(rangeAttempts.map((attempt) => attempt.questionId));
    const activityTotals = rangeAttempts.reduce((result, attempt) => ({ total: result.total + 1, correct: result.correct + (attempt.correct ? 1 : 0) }), { total: 0, correct: 0 });
    const newQuestions = lifetimeAttemptStats.filter((stats) => activeQuestionIds.has(stats.questionId) && calendarDate(stats.firstAttemptAt) >= activityFrom && calendarDate(stats.firstAttemptAt) <= activityTo).length;
    const totals = summarizeScopedQuestionStats(scopedStatsByQuestion);
    const averageDifficulty = attempted.length ? Math.round(attempted.reduce((sum, question) => sum + (summaries.get(question.id)?.difficulty ?? 0), 0) / attempted.length) : 0;
    return {
      noteIds, summaries, types, difficulty, tags, orderedRuns,
      total: questions.length, attempted: attempted.length, unattempted: questions.length - attempted.length,
      completion: percent(attempted.length, questions.length), wrong: wrong.length, mastered: mastered.length,
      favorites: questions.filter((question) => question.favorite).length, noted: noteIds.size,
      tagged: questions.filter((question) => question.tags.length).length,
      totalAttempts: totals.attempts, totalCorrect: totals.correct, totalWrong: totals.wrong,
      accuracy: percent(totals.correct, totals.attempts), firstAccuracy: totals.firstKnown ? percent(totals.firstCorrect, totals.firstKnown) : undefined,
      averageAttempts: totals.attemptedQuestions ? (totals.attempts / totals.attemptedQuestions).toFixed(1) : "0",
      giveUps: totals.giveUps, averageDifficulty,
      totalElapsed: totals.totalElapsedMs,
      lastAttempt: totals.lastAttemptAt,
      activity: { attempts: activityTotals.total, questions: activeQuestionIds.size, newQuestions, accuracy: percent(activityTotals.correct, activityTotals.total) },
      runCounts: { total: runStats?.total ?? runs.length, completed: runStats?.completed ?? runs.filter((run) => run.status === "completed").length, inProgress: runStats?.inProgress ?? runs.filter((run) => run.status === "in_progress").length, abandoned: runStats?.abandoned ?? runs.filter((run) => run.status === "abandoned").length },
      priorities: {
        wrong: wrong.length,
        repeatWrong: questions.filter((question) => (summaries.get(question.id)?.wrong ?? 0) >= 2).length,
        difficult: questions.filter((question) => (summaries.get(question.id)?.difficulty ?? 0) >= 70 && (summaries.get(question.id)?.total ?? 0) > 0).length,
        stubborn: questions.filter((question) => (summaries.get(question.id)?.total ?? 0) >= 3 && statsNeedWrongReview(statsByQuestion.get(question.id), wrongRemovalStreak)).length,
        favoriteUnanswered: questions.filter((question) => question.favorite && !doneByQuestion.get(question.id)).length,
        wrongNoted: wrong.filter((question) => noteIds.has(question.id)).length,
        staleWrong: wrong.filter((question) => (summaries.get(question.id)?.latest ?? referenceTime) < referenceTime - 30 * 86_400_000).length,
      },
    };
  }, [questions, attemptStats, attempts, lifetimeAttemptStats, notes, runs, runStats, roundProgress, statsByQuestion, scopedStatsByQuestion, wrongRemovalStreak, activityRange, customActivityRange, referenceTime, normalizedScope]);

  function openQuestions(preset: QuestionPreset) {
    setQuestionPreset(preset);
    onTab("questions");
  }

  const folderName = folders.find((folder) => folder.id === bank.folderId)?.name ?? "未分组";
  const latestRun = dashboard.orderedRuns[0];
  return <>
    <div className="bank-detail-heading">
      <button onClick={onBack}><ArrowLeft size={16} />返回题库管理</button>
      <div><span className="section-kicker">{folderName}</span><h1>{bankTitle(bank)}</h1><p>{bank.description || "尚未填写题库说明"}</p></div>
      <div><button onClick={onEdit}><Edit3 size={16} />编辑题库</button><button className="danger-button" onClick={onDelete}><Trash2 size={16} />删除题库</button></div>
    </div>
    <div className="bank-detail-tabs"><button className={tab === "overview" ? "active" : ""} onClick={() => onTab("overview")}>基本信息</button><button className={tab === "questions" ? "active" : ""} onClick={() => onTab("questions")}>试题管理 <span>{questions.length || bank.questionCount}</span></button></div>
    {tab === "overview" ? <div className="bank-dashboard">
      <section className="bank-profile-strip">
        <span className="bank-profile-color" style={{ background: bank.color || "#dfe9e2" }}><BookOpenCheck size={22} /></span>
        <div><strong>{bankTitle(bank)}</strong><small>{bank.name !== bankTitle(bank) ? `系统原名：${bank.name} · ` : ""}{folderName} · 导入于 {fullDate(bank.importedAt)}</small></div>
        <span>{questions.length.toLocaleString()} 道题 · {progressScopeLabel}</span>
      </section>

      <section className="bank-progress-hero">
        <div className="bank-progress-ring" style={{ background: `conic-gradient(#3f7258 ${dashboard.completion}%, #dfe5df 0)` }}><span><strong>{dashboard.completion}%</strong><small>完成度</small></span></div>
        <div className="bank-progress-copy"><span className="section-kicker">学习进度 · {progressScopeLabel}</span><h2>已做 {dashboard.attempted} 题，还有 {dashboard.unattempted} 题等待开始</h2><p>{progressScopeLabel}内错题 {dashboard.wrong} 道；连续答对 {wrongRemovalStreak} 次后计入已掌握并移出错题。</p><div className="bank-progress-bar"><i style={{ width: `${dashboard.completion}%` }} /></div></div>
        <div className="bank-progress-side"><span>{progressScopeLabel}最近作答</span><strong>{formatDateTime(dashboard.lastAttempt)}</strong><small>{latestRun ? `${latestRun.modeLabel} · ${latestRun.status === "completed" ? "已完成" : latestRun.status === "abandoned" ? "已放弃" : "进行中"}` : "还没有练习记录"}</small></div>
      </section>

      <section className="bank-kpi-grid" aria-label="题库核心指标">
        <DashboardMetric icon={<CheckCircle2 />} label="已做题目" value={dashboard.attempted} detail={`${dashboard.completion}% 完成 · ${progressScopeLabel}`} onClick={() => openQuestions("attempted")} />
        <DashboardMetric icon={<AlertTriangle />} label="当前错题" value={dashboard.wrong} detail={`${progressScopeLabel} · 连续对 ${wrongRemovalStreak} 次移除`} tone="warning" onClick={() => openQuestions("wrong")} />
        <DashboardMetric icon={<Target />} label="已掌握" value={dashboard.mastered} detail={`${progressScopeLabel} · 达到连续正确阈值`} onClick={() => openQuestions("mastered")} />
        <DashboardMetric icon={<Bookmark />} label="收藏题目" value={dashboard.favorites} detail="题库属性 · 不受时间范围影响" onClick={() => openQuestions("favorite")} />
        <DashboardMetric icon={<NotebookPen />} label="个人解析" value={dashboard.noted} detail="题库属性 · 不受时间范围影响" onClick={() => openQuestions("noted")} />
        <DashboardMetric icon={<Tag />} label="已打标签" value={dashboard.tagged} detail={`${dashboard.tags.length} 个标签 · 不受时间范围影响`} onClick={() => openQuestions("tagged")} />
        <DashboardMetric icon={<FileText />} label="未做题目" value={dashboard.unattempted} detail={`${progressScopeLabel}尚无作答`} onClick={() => openQuestions("unattempted")} />
        <DashboardMetric icon={<Gauge />} label="平均难度" value={dashboard.averageDifficulty} suffix="/100" detail={`根据${progressScopeLabel}作答动态计算`} onClick={() => openQuestions("difficult")} />
      </section>

      <div className="bank-dashboard-grid">
        <section className="bank-dashboard-panel bank-performance-panel"><PanelTitle icon={<BarChart3 />} eyebrow="答题表现" title={`范围表现（${progressScopeLabel}）`} /><div className="bank-performance-grid">
          <DashboardNumber value={dashboard.totalAttempts} label="总作答" />
          <DashboardNumber value={`${dashboard.accuracy}%`} label="总正确率" />
          <DashboardNumber value={dashboard.firstAccuracy === undefined ? "—" : `${dashboard.firstAccuracy}%`} label="首次正确率" />
          <DashboardNumber value={dashboard.averageAttempts} label="每题平均作答" />
          <DashboardNumber value={dashboard.totalCorrect} label="答对次数" />
          <DashboardNumber value={dashboard.totalWrong} label="答错次数" />
          <DashboardNumber value={dashboard.giveUps ?? "—"} label="不会次数" />
          <DashboardNumber value={dashboard.totalElapsed === undefined ? "—" : formatDuration(dashboard.totalElapsed)} label="累计用时" />
        </div></section>
        <section className="bank-dashboard-panel bank-activity-panel"><PanelTitle icon={<CalendarClock />} eyebrow="近期活跃" title="练习节奏" /><div className="bank-range-tabs">{([1, 7, 30] as const).map((days) => <button key={days} className={activityRange === days ? "active" : ""} onClick={() => setActivityRange(days)}>{days === 1 ? "今天" : `${days} 天`}</button>)}<button className={activityRange === "custom" ? "active" : ""} onClick={() => setActivityRange("custom")}>自定义</button></div>{activityRange === "custom" && <div className="bank-custom-range"><label>开始日期<input type="date" value={customActivityRange.from} max={customActivityRange.to} onChange={(event) => setCustomActivityRange((current) => ({ ...current, from: event.target.value }))} /></label><span>至</span><label>结束日期<input type="date" value={customActivityRange.to} min={customActivityRange.from} max={calendarDate(new Date(referenceTime))} onChange={(event) => setCustomActivityRange((current) => ({ ...current, to: event.target.value }))} /></label></div>}<div className="bank-activity-grid">
          <DashboardNumber value={dashboard.activity.attempts} label="作答次数" />
          <DashboardNumber value={dashboard.activity.questions} label="练习题数" />
          <DashboardNumber value={dashboard.activity.newQuestions} label="新做题目" />
          <DashboardNumber value={`${dashboard.activity.accuracy}%`} label="正确率" />
        </div></section>
      </div>

      <div className="bank-dashboard-grid">
        <section className="bank-dashboard-panel"><PanelTitle icon={<BarChart3 />} eyebrow="题目构成" title="题型与动态难度" /><Distribution label="单选" count={dashboard.types.单选} total={dashboard.total} color="#527f67" /><Distribution label="多选" count={dashboard.types.多选} total={dashboard.total} color="#be8059" /><Distribution label="判断" count={dashboard.types.判断} total={dashboard.total} color="#758b9d" /><Distribution label="计算" count={dashboard.types.计算} total={dashboard.total} color="#8b6f9d" /><div className="bank-distribution-separator" /><Distribution label="容易" count={dashboard.difficulty.easy} total={dashboard.attempted} color="#6b9b7d" /><Distribution label="中等" count={dashboard.difficulty.medium} total={dashboard.attempted} color="#d5a151" /><Distribution label="困难" count={dashboard.difficulty.hard} total={dashboard.attempted} color="#be6651" /></section>
        <section className="bank-dashboard-panel"><PanelTitle icon={<AlertTriangle />} eyebrow="复习优先级" title="下一步该看什么" /><div className="bank-priority-grid">
          <PriorityButton label="当前错题" count={dashboard.priorities.wrong} onClick={() => openQuestions("wrong")} />
          <PriorityButton label="错两次及以上" count={dashboard.priorities.repeatWrong} onClick={() => openQuestions("repeatWrong")} />
          <PriorityButton label="高难题" count={dashboard.priorities.difficult} onClick={() => openQuestions("difficult")} />
          <PriorityButton label="反复出错" count={dashboard.priorities.stubborn} onClick={() => openQuestions("stubborn")} />
          <PriorityButton label="收藏但未做" count={dashboard.priorities.favoriteUnanswered} onClick={() => openQuestions("favoriteUnanswered")} />
          <PriorityButton label="错题且有解析" count={dashboard.priorities.wrongNoted} onClick={() => openQuestions("wrongNoted")} />
          <PriorityButton label="30 天未复习错题" count={dashboard.priorities.staleWrong} onClick={() => openQuestions("staleWrong")} wide />
        </div></section>
      </div>

        <section className="bank-dashboard-panel"><PanelTitle icon={<Tag />} eyebrow="知识标签" title="标签掌握情况" />{dashboard.tags.length ? <div className="bank-tag-table"><div><span>标签</span><span>题目</span><span>当前错题</span><span>终身正确率</span></div>{dashboard.tags.slice(0, 10).map((tag) => <div key={tag.name}><strong>{tag.name}</strong><span>{tag.count}</span><span>{tag.wrong}</span><span>{tag.accuracy}%</span></div>)}</div> : <div className="bank-panel-empty"><Tag size={20} /><span>还没有用户标签，可在试题管理或答题界面添加。</span></div>}</section>

      <section className="bank-dashboard-panel"><PanelTitle icon={<History />} eyebrow="练习记录" title="最近练习" /><div className="bank-run-summary"><span>共 {dashboard.runCounts.total} 次</span><span>{dashboard.runCounts.completed} 次完成</span><span>{dashboard.runCounts.inProgress} 次进行中</span><span>{dashboard.runCounts.abandoned} 次放弃</span></div>{dashboard.orderedRuns.length ? <div className="bank-recent-runs">{dashboard.orderedRuns.slice(0, 5).map((run) => <button key={run.id} onClick={() => onOpenRun(run.id)}><span className={`run-status ${run.status}`}>{run.status === "completed" ? "已完成" : run.status === "abandoned" ? "已放弃" : "进行中"}</span><span><strong>{run.modeLabel}</strong><small>{formatDateTime(run.updatedAt)}</small></span><span>{runAnswered(run)} / {run.questionIds.length} 题</span><strong>{runAccuracy(run)}%</strong><ChevronRight size={16} /></button>)}</div> : <div className="bank-panel-empty"><Clock3 size={20} /><span>还没有练习记录。</span></div>}</section>

      <section className="bank-profile-details"><div><span>系统原名</span><strong>{bank.name}</strong></div><div><span>所属文件夹</span><strong>{folderName}</strong></div><div><span>导入日期</span><strong>{fullDate(bank.importedAt)}</strong></div><div><span>题库信息更新</span><strong>{formatDateTime(bank.updatedAt || bank.importedAt)}</strong></div></section>
    </div> : <QuestionManager bank={bank} questions={questions} attemptStats={attemptStats} notes={notes} roundProgress={roundProgress} progressScope={progressScope} preset={questionPreset} wrongRemovalStreak={wrongRemovalStreak} referenceTime={referenceTime} onPresetChange={setQuestionPreset} onNotice={onNotice} />}
  </>;
}

function DashboardMetric({ icon, label, value, suffix, detail, tone, onClick }: { icon: ReactNode; label: string; value: number; suffix?: string; detail: string; tone?: "warning"; onClick: () => void }) {
  return <button className={tone ? `bank-kpi ${tone}` : "bank-kpi"} onClick={onClick}><span>{icon}</span><div><small>{label}</small><strong>{value.toLocaleString()}<em>{suffix}</em></strong><p>{detail}</p></div><ChevronRight size={15} /></button>;
}
function DashboardNumber({ value, label }: { value: number | string; label: string }) { return <div className="bank-dashboard-number"><strong>{typeof value === "number" ? value.toLocaleString() : value}</strong><span>{label}</span></div>; }
function PanelTitle({ icon, eyebrow, title }: { icon: ReactNode; eyebrow: string; title: string }) { return <header className="bank-panel-title"><span>{icon}</span><div><small>{eyebrow}</small><h2>{title}</h2></div></header>; }
function Distribution({ label, count, total, color }: { label: string; count: number; total: number; color: string }) { return <div className="bank-distribution"><span>{label}</span><div><i style={{ width: `${percent(count, total)}%`, background: color }} /></div><strong>{count}<small>{percent(count, total)}%</small></strong></div>; }
function PriorityButton({ label, count, onClick, wide }: { label: string; count: number; onClick: () => void; wide?: boolean }) { return <button className={wide ? "wide" : ""} onClick={onClick}><span>{label}</span><strong>{count}</strong><ChevronRight size={15} /></button>; }

function QuestionManager({ bank, questions, attemptStats, notes, roundProgress = [], progressScope = { type: "rolling", days: 90 }, preset, wrongRemovalStreak, referenceTime, onPresetChange, onNotice }: { bank: Bank; questions: Question[]; attemptStats: AttemptStats[]; notes: Note[]; roundProgress?: Array<{ key: string; roundId: string; questionId: string; attempts: number; correct: number; wrong: number; firstAttemptAt: string; latestAttemptAt: string }>; progressScope?: ProgressScope; preset: QuestionPreset; wrongRemovalStreak: number; referenceTime: number; onPresetChange: (preset: QuestionPreset) => void; onNotice: (message: string) => void }) {
  const [query, setQuery] = useState(""); const [type, setType] = useState<"全部" | QuestionType>("全部"); const [visible, setVisible] = useState(80); const [editing, setEditing] = useState<Question>(); const [adding, setAdding] = useState(false); const [pendingDelete, setPendingDelete] = useState<Question>(); const [deleting, setDeleting] = useState(false);
  const statsByQuestion = useMemo(() => new Map(attemptStats.map((stats) => [stats.questionId, stats])), [attemptStats]);
  const noteIds = useMemo(() => new Set(notes.filter((note) => note.content.trim()).map((note) => note.questionId)), [notes]);
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
  const blankCanonical: QuestionV6 = { id: "draft", type: "单选", content: [{ id: "stem-0", type: "text", text: "" }], options: [0, 1, 2, 3].map((index) => [{ id: `option-${index}-0`, type: "text", text: "" }]), answer: "A", tags: [], favorite: false, contentFingerprint: "0".repeat(64), updatedAt: new Date().toISOString(), deviceId: "draft" };
  return <section className="question-manager"><header><div className="question-manager-search"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setVisible(80); }} placeholder="搜索题干、选项或标签" /></div><AppSelect ariaLabel="统计条件筛选" value={preset} onValueChange={(value) => { onPresetChange(value as QuestionPreset); setVisible(80); }} options={(Object.keys(PRESET_LABELS) as QuestionPreset[]).map((value) => ({ value, label: PRESET_LABELS[value] }))} /><AppSelect ariaLabel="筛选题型" value={type} onValueChange={(value) => { setType(value as "全部" | QuestionType); setVisible(80); }} options={["全部", "单选", "多选", "判断", "计算"].map((value) => ({ value, label: value }))} /><button className="primary" onClick={() => setAdding(true)}><Plus size={16} />新增题目</button></header><p className="question-manager-count">当前条件：{PRESET_LABELS[preset]} · 找到 {filtered.length} 道题，当前显示 {Math.min(visible, filtered.length)} 道</p><div className="managed-question-list">{filtered.slice(0, visible).map((question, index) => { const summary = summarizeAttemptStats(statsByQuestion.get(question.id)); return <article key={question.id}><span>{index + 1}</span><button onClick={() => setEditing(question)}><div><em>{question.type}</em>{question.tags.map((tag) => <i key={tag}>{tag}</i>)}</div><ContentBlockRenderer blocks={question.canonical.content} loadAsset={loadImageAssetV6} /><small>答案 {question.answer} · 作答 {summary.total} 次（终身） · 正确 {summary.correct} 次（终身） · 错误 {summary.wrong} 次（终身）</small></button><div><button aria-label="编辑题目" onClick={() => setEditing(question)}><Pencil size={15} /></button><button aria-label="删除题目" onClick={() => setPendingDelete(question)}><Trash2 size={15} /></button></div></article>; })}</div>{visible < filtered.length && <button className="search-load-more" onClick={() => setVisible(visible + 80)}>继续加载（{visible} / {filtered.length}）</button>}{!filtered.length && <div className="question-manager-empty"><Search /><h3>没有符合条件的题目</h3><p>可以切换统计条件、题型或清空关键词。</p></div>}{editing && <SharedQuestionEditor question={editing.canonical} preferredBankId={bank.id} onCancel={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); onNotice("题目已保存"); }} />}{adding && <QuestionEditor question={blankCanonical} title="新增题目" eyebrow={`添加到 ${bankTitle(bank)}`} submitLabel="添加题目" onCancel={() => setAdding(false)} onSave={async (changes: QuestionChanges) => { await createQuestionV6(bank.id, changes); setAdding(false); onNotice("新题目已添加"); }} />}<BankQuestionDeleteDialog question={pendingDelete} bank={bank} busy={deleting} onClose={() => setPendingDelete(undefined)} onBusy={setDeleting} onNotice={onNotice} /></section>;
}

function BankQuestionDeleteDialog({ question, bank, busy, onClose, onBusy, onNotice }: { question?: Question; bank: Bank; busy: boolean; onClose: () => void; onBusy: (value: boolean) => void; onNotice: (message: string) => void }) {
  if (!question) return null;
  const target = question;
  async function removeFromBank() {
    try { onBusy(true); await removeMembershipV6(bank.id, target.id); onClose(); onNotice(`题目已从「${bankTitle(bank)}」移除，可在未归档题目中找回`); }
    catch (error) { onNotice(error instanceof Error ? error.message : "移除题目失败"); }
    finally { onBusy(false); }
  }
  async function deleteGlobally() {
    try { onBusy(true); await deleteQuestionV6(target.id); onClose(); onNotice("题目及全部学习记录已删除"); }
    catch (error) { onNotice(error instanceof Error ? error.message : "删除题目失败"); }
    finally { onBusy(false); }
  }
  return <ModalPortal><div className="simple-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="simple-dialog" role="dialog" aria-modal="true" aria-labelledby="bank-question-delete-title"><header><div><span className="section-kicker">试题管理</span><h2 id="bank-question-delete-title">如何处理这道题？</h2></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="取消删除题目"><X size={17} /></button></header><p><strong>{target.stem.slice(0, 64)}</strong></p><div className="delete-choice-list"><button disabled={busy} onClick={() => void removeFromBank()}><span>仅从当前题库移除</span><small>保留全局题目、历史作答和解析；题目会进入未归档题目。</small></button><button className="danger-button" disabled={busy} onClick={() => void deleteGlobally()}><span>全局删除题目及学习记录</span><small>从所有题库移除，并删除作答、解析、题组和练习引用。</small></button></div>{busy && <p>正在处理…</p>}<footer><button disabled={busy} onClick={onClose}>取消</button></footer></section></div></ModalPortal>;
}

function BankEditDialog({ bank, folders, onClose, onSaved }: { bank: Bank; folders: BankFolder[]; onClose: () => void; onSaved: (name: string) => void }) {
  const [name, setName] = useState(bankTitle(bank)); const [description, setDescription] = useState(bank.description ?? ""); const [folderId, setFolderId] = useState(bank.folderId ?? "unfiled"); const [color, setColor] = useState(bank.color ?? "#dfe9e2");
  return <ModalPortal><div className="simple-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="simple-dialog"><header><div><span className="section-kicker">题库资料</span><h2>编辑题库</h2></div><button className="icon-button" aria-label="关闭编辑题库" onClick={onClose}><X size={17} /></button></header><div><label>展示名称<input value={name} onChange={(event) => setName(event.target.value)} /><small>系统原名保持为“{bank.name}”，不会影响同步识别。</small></label><label>题库说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="用途、范围或备注" /></label><label htmlFor="bank-folder-select">所属文件夹<AppSelect id="bank-folder-select" ariaLabel="所属文件夹" value={folderId} onValueChange={setFolderId} options={[{ value: "unfiled", label: "未分组" }, ...folders.map((folder) => ({ value: folder.id, label: folder.name }))]} /></label><label>识别颜色<span className="color-field"><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /><em>{color}</em></span></label></div><footer><button onClick={onClose}>取消</button><button className="primary" disabled={!name.trim()} onClick={async () => { const saved = await saveBank(bank.id, { displayName: name, description, folderId: folderId === "unfiled" ? undefined : folderId || undefined, color, sortOrder: bank.sortOrder }); onSaved(bankTitle(saved)); }}>保存题库</button></footer></section></div></ModalPortal>;
}

function FolderDialog({ folder, onClose, onSaved }: { folder?: BankFolder; onClose: () => void; onSaved: (name: string) => void }) {
  const [name, setName] = useState(folder?.name ?? ""); const [description, setDescription] = useState(folder?.description ?? "");
  return <ModalPortal><div className="simple-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="simple-dialog small"><header><div><span className="section-kicker">题库分组</span><h2>{folder ? "编辑文件夹" : "新建文件夹"}</h2></div><button className="icon-button" aria-label="关闭文件夹编辑" onClick={onClose}><X size={17} /></button></header><div><label>文件夹名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：送电线路工" /></label><label>说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="可选" /></label></div><footer><button onClick={onClose}>取消</button><button className="primary" disabled={!name.trim()} onClick={async () => { const saved = await saveBankFolder({ id: folder?.id, name, description }); onSaved(saved.name); }}>保存文件夹</button></footer></section></div></ModalPortal>;
}
