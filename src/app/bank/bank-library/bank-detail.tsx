"use client";
import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AlertTriangle, ArrowLeft, BarChart3, BookOpenCheck, Bookmark, CalendarClock, CheckCircle2, ChevronRight, Clock3, Download, Edit3, FileText, Gauge, History, NotebookPen, Tag, Target, Trash2 } from "lucide-react";
import { dbV7 } from "@/lib/db/db-v7";
import { listQuestionViewsForBankV7 } from "@/lib/db/app-data-v7";
import { toQuestionViewModel } from "@/app/bank/question-editor";
import { calendarDate, statsNeedWrongReview, summarizeAttemptStats } from "@/lib/practice/practice-metrics";
import { buildScopedQuestionStats, isQuestionDoneInScope, normalizeProgressScope, scopedStatsToLegacyAttemptStats, summarizeScopedQuestionStats, type ProgressScope } from "@/lib/practice/progress-scope";
import { bankTitle, formatDateTime, formatDuration, fullDate, percent, runAccuracy, runAnswered, type ActivityRange, type AttemptStats, type Bank, type BankFolder, type Question, type QuestionPreset, type QuestionType } from "./bank-library-shared";
import { BankExportDialog } from "./bank-export-dialog";
import { QuestionManager } from "./question-manager";
import { DashboardMetric, DashboardNumber, Distribution, PanelTitle, PriorityButton } from "./bank-dashboard-widgets";

export function BankDetail({ bank, folders, progressScope, progressScopeLabel, tab, wrongRemovalStreak, onTab, onImportQuestions, onBack, onEdit, onDelete, onOpenRun, onNotice }: { bank: Bank; folders: BankFolder[]; progressScope: ProgressScope; progressScopeLabel: string; tab: "overview" | "questions"; wrongRemovalStreak: number; onTab: (tab: "overview" | "questions") => void; onImportQuestions: () => void; onBack: () => void; onEdit: () => void; onDelete: () => void; onOpenRun: (runId: string) => void; onNotice: (message: string) => void }) {
  const [questionPreset, setQuestionPreset] = useState<QuestionPreset>("all");
  const [activityRange, setActivityRange] = useState<ActivityRange>(7);
  const [exportOpen, setExportOpen] = useState(false);
  const [referenceTime] = useState(Date.now);
  const defaultCustomFrom = new Date(referenceTime);
  defaultCustomFrom.setDate(defaultCustomFrom.getDate() - 6);
  const [customActivityRange, setCustomActivityRange] = useState({ from: calendarDate(defaultCustomFrom), to: calendarDate(new Date(referenceTime)) });
  const dataset = useLiveQuery(async () => {
    const views = await listQuestionViewsForBankV7(bank.id);
    const questions = views.map((view) => toQuestionViewModel(view.question, bank.id, bankTitle(bank), view.memberships[0]?.sortOrder ?? 0));
    const questionIds = new Set(questions.map((question) => question.id));
    const [rawStats, rawAttempts, allNotes, allRuns, runStats, roundProgress] = await Promise.all([
      dbV7.attemptStats.toArray(),
      dbV7.attempts.toArray(),
      dbV7.notes.toArray(),
      dbV7.practiceRuns.toArray(),
      dbV7.practiceRunStats.get(bank.id),
      dbV7.reviewRoundProgress.toArray(),
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
  const attemptStats = useMemo<AttemptStats[]>(() => [...scopedStatsByQuestion.values()].map((stats) => scopedStatsToLegacyAttemptStats(stats, bank.id)), [bank.id, scopedStatsByQuestion]);
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
      <div><button onClick={() => setExportOpen(true)}><Download size={16} />导出题库</button><button onClick={onEdit}><Edit3 size={16} />编辑题库</button><button className="danger-button" onClick={onDelete}><Trash2 size={16} />删除题库</button></div>
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
    </div> : <QuestionManager bank={bank} questions={questions} attemptStats={attemptStats} notes={notes} roundProgress={roundProgress} progressScope={progressScope} progressScopeLabel={progressScopeLabel} preset={questionPreset} wrongRemovalStreak={wrongRemovalStreak} referenceTime={referenceTime} onPresetChange={setQuestionPreset} onImportQuestions={onImportQuestions} onNotice={onNotice} />}
    {exportOpen && <BankExportDialog bank={bank} questions={questions} notes={notes} onClose={() => setExportOpen(false)} onNotice={onNotice} />}
  </>;
}
