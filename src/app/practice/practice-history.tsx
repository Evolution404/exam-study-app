import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, BookOpenCheck, CheckCircle2, ChevronDown, ChevronRight, Clock3, GitBranch, Grid3X3, History, Pencil, Play, RotateCcw, Star, Trash2, XCircle } from "lucide-react";
import { dbV7, updateQuestionV7 } from "@/lib/db/db-v7";
import { MathText } from "@/app/ui/math-text";
import { formatCalculationAnswers, solutionAnswerText } from "@/lib/question/question-utils";
import { Hint } from "@/app/ui/hint";
import { SharedQuestionEditor, toQuestionViewModel, type QuestionViewModel } from "@/app/bank/question-editor";
import { QuestionDetail } from "@/app/bank/question-detail";
import { QuestionOverview } from "@/app/shell/views/question-overview";
import { runActivityAt, summarizeAttemptStats } from "@/lib/practice/practice-metrics";
import { buildScopedQuestionStats, scopedStatsToAttemptStats, type ProgressScope } from "@/lib/practice/progress-scope";
import { DEFAULT_KEYBOARD_SHORTCUTS, normalizeKeyboardShortcuts } from "@/lib/practice/keyboard-shortcuts";
import type { PracticeRunV7, QuestionTypeV7 } from "@/lib/db/v7-types";
import { QUESTION_TYPE_ORDER } from "@/types/types";

const TYPE_ORDER: QuestionTypeV7[] = [...QUESTION_TYPE_ORDER];

function runStats(run: PracticeRunV7) {
  const submitted = Object.values(run.answers).filter((answer) => answer.submitted);
  const correct = submitted.filter((answer) => answer.correct).length;
  return { answered: submitted.length, correct, wrong: submitted.length - correct, accuracy: submitted.length ? Math.round(correct / submitted.length * 100) : 0 };
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

const statusText: Record<PracticeRunV7["status"], string> = { in_progress: "进行中", completed: "已完成", abandoned: "已放弃" };

export function LatestPracticeBanner({ onContinue, onAbandon, onViewAll }: { onContinue: (runId: string) => void; onAbandon: (runId: string) => void; onViewAll: () => void }) {
  const run = useLiveQuery(() => dbV7.practiceRuns.where("status").equals("in_progress").sortBy("updatedAt").then((rows) => rows.at(-1)), []);
  if (!run) return null;
  const stats = runStats(run);
  return <section className="latest-practice-banner">
    <div className="latest-practice-copy"><span className="section-kicker">继续最近练习</span><h2>{run.modeLabel}</h2><p>{run.bankName} · {formatTime(run.updatedAt)}</p><div className="latest-practice-progress"><i><b style={{ width: `${run.questionIds.length ? stats.answered / run.questionIds.length * 100 : 0}%` }} /></i><span>{stats.answered} / {run.questionIds.length} 已作答</span><span>{stats.accuracy}% 正确率</span></div><div className="latest-practice-actions"><button type="button" onClick={() => onContinue(run.id)}><Play size={16} fill="currentColor" />继续练习</button><Hint label="放弃练习"><button type="button" className="latest-practice-abandon" aria-label="放弃练习" onClick={() => onAbandon(run.id)}><XCircle size={17} /></button></Hint><button type="button" className="feature-secondary" onClick={onViewAll}><History size={16} />全部练习记录</button></div></div>
    <div className="latest-practice-score"><strong>{stats.answered}</strong><small>已答题</small><span>{stats.correct} 对 · {stats.wrong} 错</span></div>
  </section>;
}

function HistoryRunCard({ run, onOpen, onContinue, onAbandon, onDelete }: { run: PracticeRunV7; onOpen: (runId: string) => void; onContinue: (runId: string) => void; onAbandon: (runId: string) => void; onDelete: (runId: string) => void }) {
  const stats = runStats(run);
  const [offset, setOffset] = useState(0);
  const drag = useRef<{ x: number; y: number; offset: number; horizontal: boolean } | null>(null);
  const suppressClick = useRef(false);
  const finishSwipe = () => {
    if (!drag.current) return;
    setOffset((current) => current < -34 ? -68 : 0);
    suppressClick.current = Math.abs(offset - drag.current.offset) > 5;
    drag.current = null;
  };
  return <article className={offset < 0 ? "swiped" : ""}>
    <Hint label="删除这条练习记录"><button type="button" className="history-delete-action" aria-label={`删除${run.modeLabel}记录`} onClick={() => onDelete(run.id)}><Trash2 size={20} /></button></Hint>
    <div
      className="history-swipe-content"
      style={{ transform: `translateX(${offset}px)` }}
      onPointerDown={(event) => { if (event.button !== 0) return; drag.current = { x: event.clientX, y: event.clientY, offset, horizontal: false }; suppressClick.current = false; }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const dx = event.clientX - drag.current.x;
        const dy = event.clientY - drag.current.y;
        if (!drag.current.horizontal && Math.abs(dx) < 7) return;
        if (!drag.current.horizontal && Math.abs(dy) > Math.abs(dx)) { drag.current = null; return; }
        drag.current.horizontal = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setOffset(Math.max(-68, Math.min(0, drag.current.offset + dx)));
      }}
      onPointerUp={finishSwipe}
      onPointerCancel={finishSwipe}
    >
      <button type="button" className={run.status === "in_progress" ? "history-open has-actions" : "history-open"} onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } if (offset < 0) { setOffset(0); return; } onOpen(run.id); }}><div className="history-title"><span className={`run-status ${run.status}`}>{statusText[run.status]}</span><strong>{run.modeLabel}</strong><small>{formatTime(runActivityAt(run))}</small></div><h3>{run.bankName}</h3><div className="history-metrics"><span><b>{stats.answered}</b> / {run.questionIds.length} 已作答</span><span><b>{stats.accuracy}%</b> 正确率</span><span>{stats.correct} 对 · {stats.wrong} 错</span></div>{run.status !== "in_progress" && <ChevronRight size={18} />}</button>
      {run.status === "in_progress" && <div className="history-card-actions"><Hint label="继续练习"><button type="button" aria-label="继续练习" onClick={() => onContinue(run.id)}><Play size={15} fill="currentColor" /></button></Hint><Hint label="放弃练习"><button type="button" className="abandon" aria-label="放弃练习" onClick={() => onAbandon(run.id)}><XCircle size={16} /></button></Hint></div>}
    </div>
  </article>;
}

export function PracticeHistory({ onOpen, onContinue, onAbandon, onDelete }: { onOpen: (runId: string) => void; onContinue: (runId: string) => void; onAbandon: (runId: string) => void; onDelete: (runId: string) => void }) {
  const runsQuery = useLiveQuery(() => dbV7.practiceRuns.toArray(), []);
  const runs = runsQuery ?? [];
  // 排序口径：最后活动时间（已完成=完成时间，其余=最后一道作答题的时间），不再按开始时间。
  const ordered = useMemo(() => (runsQuery ?? []).slice().sort((a, b) => runActivityAt(b).localeCompare(runActivityAt(a))), [runsQuery]);
  const [status, setStatus] = useState<"all" | PracticeRunV7["status"]>("all");
  const [visibleLimit, setVisibleLimit] = useState(50);
  const filtered = status === "all" ? ordered : ordered.filter((run) => run.status === status);
  const visible = filtered.slice(0, visibleLimit);
  return <section className="practice-history-card">
    <header><div><span className="section-kicker">每次练习都有迹可循</span><h2>练习记录</h2><p>进行中、已完成和已放弃的练习都会保留。</p></div><History size={24} /></header>
    <div className="history-filters">{(["all", "in_progress", "completed", "abandoned"] as const).map((item) => <button key={item} className={status === item ? "active" : ""} onClick={() => { setStatus(item); setVisibleLimit(50); }}>{item === "all" ? "全部" : statusText[item]}<span>{item === "all" ? runs.length : runs.filter((run) => run.status === item).length}</span></button>)}</div>
    {visible.length ? <div className="history-list">{visible.map((run) => <HistoryRunCard key={run.id} run={run} onOpen={onOpen} onContinue={onContinue} onAbandon={onAbandon} onDelete={onDelete} />)}</div> : <div className="history-empty"><Clock3 /><h3>这里还没有记录</h3><p>开始一组练习后，会立即建立可恢复的练习记录。</p></div>}
    {visible.length < filtered.length && <button className="search-load-more" onClick={() => setVisibleLimit((current) => current + 50)}>继续加载（{visible.length} / {filtered.length}）</button>}
  </section>;
}

export function PracticeRunResult({ runId, onBack, onContinue, onRepeat, onNotice, onGroup, progressScope = { type: "lifetime" }, scopeLabel = "全部时间" }: { runId: string; onBack: () => void; onContinue?: (runId: string, index: number) => void; onRepeat: (questions: QuestionViewModel[], label: string, previousOptionOrders: Record<string, number[]>) => void; onNotice?: (message: string) => void; onGroup?: (questionIds: string[]) => void; progressScope?: ProgressScope; scopeLabel?: string }) {
  const data = useLiveQuery(async () => {
    const run = await dbV7.practiceRuns.get(runId);
    if (!run) return undefined;
    const questions = (await dbV7.questions.bulkGet(run.questionIds)).filter(Boolean);
    const memberships = run.questionIds.length ? await dbV7.bankQuestionMemberships.where("questionId").anyOf(run.questionIds).toArray() : [];
    const bankIds = [...new Set(memberships.map((membership) => membership.bankId))];
    const banks = (await dbV7.banks.bulkGet(bankIds)).filter((bank) => bank !== undefined);
    return { run, questions: questions.map((question) => { const membership = memberships.find((item) => item.questionId === question!.id); const bank = banks.find((item) => item.id === membership?.bankId); return toQuestionViewModel(question!, membership?.bankId, bank?.displayName || bank?.name || "未归档题目", membership?.sortOrder ?? 0); }) };
  }, [runId]);
  const [filter, setFilter] = useState<"all" | "wrong" | "unanswered">("all");
  const [detailQuestion, setDetailQuestion] = useState<QuestionViewModel>();
  const [activeResultQuestionId, setActiveResultQuestionId] = useState<string>();
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [collapsedTypes, setCollapsedTypes] = useState<Set<QuestionTypeV7>>(() => new Set());
  const ordered = useMemo(() => {
    if (!data) return [];
    const index = new Map(data.run.questionIds.map((id, itemIndex) => [id, itemIndex]));
    return TYPE_ORDER.flatMap((type) => data.questions.filter((question) => question.type === type).sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0)));
  }, [data]);

  useEffect(() => {
    if (!detailQuestion) return;
    document.querySelector(`.result-question-groups button[data-question-id="${detailQuestion.id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [detailQuestion]);
  if (data === undefined) return <section className="run-result loading">正在读取练习记录…</section>;
  if (!data) return <section className="run-result"><button className="back-link" onClick={onBack}><ArrowLeft size={16} />返回</button><h2>这条练习记录不存在</h2></section>;
  const { run } = data;
  const stats = runStats(run);
  const visible = ordered.filter((question) => {
    const answer = run.answers[question.id];
    if (filter === "wrong") return answer?.submitted && !answer.correct;
    if (filter === "unanswered") return !answer?.submitted;
    return true;
  });
  const wrongQuestions = ordered.filter((question) => run.answers[question.id]?.submitted && !run.answers[question.id]?.correct);
  const originalIndex = new Map(run.questionIds.map((id, index) => [id, index]));
  return <section className="run-result">
    <header><button className="back-link" onClick={onBack}><ArrowLeft size={16} />返回练习记录</button><span className={`run-status ${run.status}`}>{statusText[run.status]}</span><h1>{run.modeLabel}</h1><p>{run.bankName} · {formatTime(run.startedAt)}</p></header>
    <div className="result-score"><div><strong>{stats.accuracy}<small>%</small></strong><span>本次正确率</span></div><div className="result-score-grid"><span><b>{run.questionIds.length}</b>计划题目</span><span><b>{stats.answered}</b>已作答</span><span className="correct"><b>{stats.correct}</b>正确</span><span className="wrong"><b>{stats.wrong}</b>错误</span></div></div>
    <div className="result-actions"><button className="primary" onClick={() => onRepeat(ordered, `重练 · ${run.modeLabel}`, run.optionOrders)}><RotateCcw size={16} />重练本次题目</button>{wrongQuestions.length > 0 && <button className="danger" onClick={() => onRepeat(wrongQuestions, `集中重练 ${wrongQuestions.length} 道错题`, run.optionOrders)}><XCircle size={16} />只练本次错题</button>}{run.status === "in_progress" && onContinue && <button onClick={() => onContinue(run.id, Math.max(0, run.questionIds.findIndex((id) => !run.answers[id]?.submitted)))}><BookOpenCheck size={16} />继续本次练习</button>}</div>
    <div className="result-filters">{(["all", "wrong", "unanswered"] as const).map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "all" ? "全部题目" : item === "wrong" ? "只看错题" : "只看未答"}</button>)}<button className="result-overview-trigger" aria-label="打开题目总览" onClick={() => setOverviewOpen(true)}><Grid3X3 size={15} />题目总览</button></div>
    <div className="result-question-groups">{TYPE_ORDER.map((type) => { const questions = visible.filter((question) => question.type === type); if (!questions.length) return null; const collapsed = collapsedTypes.has(type); return <section key={type} className={collapsed ? "collapsed" : ""}><header><button type="button" className="result-group-toggle" aria-expanded={!collapsed} aria-label={`${collapsed ? "展开" : "折叠"}${type}题目列表`} onClick={() => setCollapsedTypes((current) => { const next = new Set(current); if (next.has(type)) next.delete(type); else next.add(type); return next; })}><span className="result-group-title">{type}</span><span className="result-group-count">{questions.length} 题</span><ChevronDown size={16} /></button></header>{!collapsed && <div>{questions.map((question) => { const answer = run.answers[question.id]; const state = !answer?.submitted ? "unanswered" : answer.correct ? "correct" : "wrong"; return <button key={question.id} data-question-id={question.id} className={(detailQuestion?.id ?? activeResultQuestionId) === question.id ? "detail-current" : ""} aria-label={`查看第 ${(originalIndex.get(question.id) ?? 0) + 1} 题详情`} onClick={() => { setActiveResultQuestionId(question.id); setDetailQuestion(question); }}><span className={`result-state ${state}`}>{state === "correct" ? <CheckCircle2 /> : state === "wrong" ? <XCircle /> : <Clock3 />}</span><span><strong>{(originalIndex.get(question.id) ?? 0) + 1}. <MathText text={question.stem} /></strong><small>{state === "unanswered" ? "未作答" : `正确答案：${question.solution.kind === "calculation" ? formatCalculationAnswers(question.solution.blanks.map((blank) => String(blank.expected))) : solutionAnswerText(question.solution, question.optionIds ?? [])} · 你的答案：${answer.selected.length ? question.type === "计算" ? formatCalculationAnswers(answer.selected) : [...answer.selected].sort().join("") : "不会"}`}</small></span><ChevronRight size={16} /></button>; })}</div>}</section>; })}</div>
    {overviewOpen && <QuestionOverview questionIds={run.questionIds} questionTypes={run.questionTypes} answers={run.answers} currentIndex={activeResultQuestionId ? run.questionIds.indexOf(activeResultQuestionId) : -1} onClose={() => setOverviewOpen(false)} onJump={(target) => { const targetId = run.questionIds[target]; const targetQuestion = ordered.find((question) => question.id === targetId); if (targetQuestion) { setActiveResultQuestionId(targetId); setDetailQuestion(targetQuestion); } setOverviewOpen(false); }} />}
    {detailQuestion && <ResultQuestionDetail question={detailQuestion} answer={run.answers[detailQuestion.id]} entries={visible} progressScope={progressScope} scopeLabel={scopeLabel} onClose={() => { setActiveResultQuestionId(detailQuestion.id); setDetailQuestion(undefined); }} onNavigate={(id) => { setActiveResultQuestionId(id); setDetailQuestion(visible.find((item) => item.id === id)); }} onNotice={onNotice} onGroup={onGroup} />}
  </section>;
}

function ResultQuestionDetail({ question, answer, entries, progressScope, scopeLabel, onClose, onNavigate, onNotice, onGroup }: { question: QuestionViewModel; answer?: PracticeRunV7["answers"][string]; entries: QuestionViewModel[]; progressScope: ProgressScope; scopeLabel: string; onClose: () => void; onNavigate: (id: string) => void; onNotice?: (message: string) => void; onGroup?: (questionIds: string[]) => void }) {
  const note = useLiveQuery(() => dbV7.notes.get(question.id), [question.id]);
  const attempts = useLiveQuery(() => dbV7.attempts.where("questionId").equals(question.id).toArray(), [question.id]);
  const [referenceTime] = useState(() => Date.now());
  const metric = useMemo(() => {
    const scoped = buildScopedQuestionStats([question.id], progressScope, attempts ?? [], [], referenceTime).get(question.id);
    return scoped ? summarizeAttemptStats(scopedStatsToAttemptStats(scoped)) : summarizeAttemptStats();
  }, [question.id, attempts, progressScope, referenceTime]);
  const navPrefs = useMemo(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("study-v7-preferences") ?? localStorage.getItem("study-v6-preferences") ?? "{}");
      return { keyboardShortcuts: normalizeKeyboardShortcuts(saved.keyboardShortcuts), swipeNavigation: saved.swipeNavigation !== false };
    } catch {
      return { keyboardShortcuts: DEFAULT_KEYBOARD_SHORTCUTS, swipeNavigation: true };
    }
  }, []);
  const index = entries.findIndex((entry) => entry.id === question.id);
  const nav = index >= 0 ? { index, total: entries.length, onPrevious: () => onNavigate(entries[index - 1].id), onNext: () => onNavigate(entries[index + 1].id), keyboardShortcuts: navPrefs.keyboardShortcuts, swipeNavigation: navPrefs.swipeNavigation } : undefined;
  const [editing, setEditing] = useState(false);
  return <><QuestionDetail question={question} metric={metric} scopeLabel={scopeLabel} note={note?.content} answer={answer} onClose={onClose} nav={nav} footer={<><button onClick={async () => { const updated = await updateQuestionV7(question.id, { favorite: !question.favorite }); onNotice?.(updated.favorite ? "已收藏这道题" : "已取消收藏"); }}><Star size={16} fill={question.favorite ? "currentColor" : "none"} />{question.favorite ? "已收藏" : "收藏"}</button><button onClick={() => setEditing(true)}><Pencil size={16} />编辑题目</button>{onGroup && <button onClick={() => onGroup([question.id])}><GitBranch size={16} />加入题组</button>}</>} />{editing && <SharedQuestionEditor question={question.canonical} preferredBankId={question.bankId} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); onNotice?.("题目和标签已保存"); }} />}</>;
}
