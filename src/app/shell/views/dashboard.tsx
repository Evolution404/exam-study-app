"use client";
import { BookOpen, Brain, Check, ChevronRight, FileUp, ListFilter, NotebookPen, Play, Target, X } from "lucide-react";
import { ScopeSummaryChips } from "@/app/ui/scope-summary-chips";
import { Hint } from "@/app/ui/hint";
import { formatDate, type PracticeRun } from "../helpers";
import { Stat } from "./stat";
import { EmptyImport } from "./empty-import";

export function Dashboard({ groupSize, dailyGoalCount, dailyGoalAccuracy, scopeProgress, scopeLabel, scopeStats, stats, banks, latestPracticeRun, selectedBankIds, onBankToggle, onImport, onStart, onResume, onDiscardResume, onMoreModes }: {
  groupSize: number;
  dailyGoalCount: number;
  dailyGoalAccuracy: number;
  scopeProgress: { completed: number; total: number };
  scopeLabel: string;
  scopeStats: { questions: number; attempts: number; correct: number; notes: number; bankCount: number; last?: string };
  stats: { questions: number; attempts: number; correct: number; todayAttempts: number; todayCorrect: number; pending: number; notes: number; last?: string };
  banks: Array<{ id: string; name: string; displayName?: string; questionCount: number }>;
  latestPracticeRun?: PracticeRun;
  selectedBankIds: string[];
  onBankToggle: (bankId: string) => void;
  onImport: () => void; onStart: () => void; onResume: (runId: string) => void; onDiscardResume: (runId: string) => void; onMoreModes: () => void;
}) {
  const scopeAccuracy = scopeStats.attempts ? Math.round(scopeStats.correct / scopeStats.attempts * 100) : 0;
  const todayAccuracy = stats.todayAttempts ? Math.round(stats.todayCorrect / stats.todayAttempts * 100) : 0;
  const countProgress = Math.min(100, Math.round(stats.todayAttempts / dailyGoalCount * 100));
  const selectedBanks = banks.filter((bank) => selectedBankIds.includes(bank.id));
  const selectedQuestions = selectedBanks.reduce((total, bank) => total + bank.questionCount, 0);
  const answeredInRun = latestPracticeRun ? Object.values(latestPracticeRun.answers).filter((answer) => answer.submitted).length : 0;
  const resumeProgress = latestPracticeRun?.questionIds.length ? Math.round(answeredInRun / latestPracticeRun.questionIds.length * 100) : 0;
  return <>
    <div className="home-heading"><h1>今日练习</h1><p>选择题库开始练习，或继续上次进度。</p>{selectedBanks.length > 0 && <div className="home-scope-summary"><ScopeSummaryChips total={scopeProgress.total} done={scopeProgress.completed} scopeLabel={scopeLabel} /></div>}</div>
    {latestPracticeRun && <section className="resume-card"><span className="resume-mark"><Play size={21} /></span><div className="resume-copy"><small>继续上次练习</small><strong>{latestPracticeRun.bankName}</strong><p>{latestPracticeRun.modeLabel}</p></div><div className="resume-progress"><div><span><b>{answeredInRun}</b> / {latestPracticeRun.questionIds.length} 已作答</span><strong>{resumeProgress}%</strong></div><i aria-label={`练习进度 ${resumeProgress}%`}><b style={{ width: `${resumeProgress}%` }} /></i></div><div className="resume-card-actions"><button className="resume-continue" onClick={() => onResume(latestPracticeRun.id)}>继续练习<ChevronRight size={17} /></button><Hint label="放弃上次练习"><button className="resume-discard" aria-label="放弃上次练习" onClick={() => onDiscardResume(latestPracticeRun.id)}><X size={16} /></button></Hint></div></section>}
    {banks.length ? <section className="home-bank-scope"><div className="scope-heading"><div><span className="section-kicker">当前题库范围</span><h2>选择一个或多个题库</h2></div><small>可以暂不选择</small></div><div className={`home-bank-grid${banks.length === 1 ? " single-bank" : ""}`}>{banks.map((bank) => { const selected = selectedBankIds.includes(bank.id); return <button key={bank.id} aria-pressed={selected} className={selected ? "selected" : ""} onClick={() => onBankToggle(bank.id)}><span className="scope-check">{selected && <Check size={14} />}</span><div><strong>{bank.displayName || bank.name}</strong><small>{bank.questionCount.toLocaleString()} 题</small></div></button>; })}</div><div className="scope-footer"><p>{selectedBanks.length ? <>已选择 <strong>{selectedBanks.length}</strong> 个题库，共 <strong>{selectedQuestions.toLocaleString()}</strong> 题</> : "尚未选择练习题库，可以先查看题库或练习配置。"}</p><button className="primary" disabled={!selectedBankIds.length} onClick={onStart}><Brain size={18} />开始随机 {groupSize} 题</button></div></section> : <EmptyImport onImport={onImport} />}
    <section className="home-feature-grid">
      <article className="daily-practice"><div><span className="section-kicker">今日推荐</span><h2>来一组 {groupSize} 题</h2><p>{selectedBankIds.length ? "从已选题库随机抽题，再按单选、多选、判断、计算分组。" : "请先选择题库，或进入更多练习模式选择题库。"}</p><div><button disabled={!selectedBankIds.length} onClick={onStart}>开始这一组<ChevronRight size={17} /></button><button className="feature-secondary" onClick={onMoreModes}><ListFilter size={16} />更多练习模式</button></div></div><span className="daily-number"><strong>{groupSize}</strong><small>题</small></span></article>
      <article className="memory-card daily-goal-card"><span>今日目标</span><blockquote>{stats.todayAttempts} / {dailyGoalCount} 题</blockquote><div className="daily-goal-progress"><i style={{ width: `${countProgress}%` }} /></div><small>今日正确率 {todayAccuracy}% · 目标 {dailyGoalAccuracy}%</small>
        <p className={stats.todayAttempts >= dailyGoalCount && todayAccuracy >= dailyGoalAccuracy ? "achieved" : ""}>{stats.todayAttempts >= dailyGoalCount && todayAccuracy >= dailyGoalAccuracy ? "今日目标已达成" : stats.todayAttempts < dailyGoalCount ? `还差 ${dailyGoalCount - stats.todayAttempts} 题` : `正确率还差 ${Math.max(0, dailyGoalAccuracy - todayAccuracy)}%`}</p>
      </article>
    </section>
    <section className="stat-grid">
      <Stat icon={<BookOpen />} label="范围题目" value={scopeStats.questions.toLocaleString()} foot={`${scopeStats.bankCount} 个题库 · ${scopeLabel}`} />
      <Stat icon={<Target />} label={`作答（${scopeLabel}）`} value={scopeStats.attempts.toLocaleString()} foot={`最近：${formatDate(scopeStats.last)}`} />
      <Stat icon={<Check />} label={`正确率（${scopeLabel}）`} value={`${scopeAccuracy}%`} foot={scopeStats.attempts ? `${scopeStats.correct} 次答对` : "当前范围尚未作答"} />
      <Stat icon={<NotebookPen />} label="个人解析（当前题库范围）" value={scopeStats.notes.toLocaleString()} foot="不受时间范围影响" />
    </section>
    <section className="section-block"><div className="section-title"><div><span className="section-kicker">题库管理</span><h2>继续扩充你的练习范围</h2></div><button className="text-button" onClick={onImport}><FileUp size={16} />导入题库</button></div></section>
  </>;
}
