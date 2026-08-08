import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, BookOpenCheck, CheckCircle2, ChevronRight, Clock3, History, Play, RotateCcw, XCircle } from "lucide-react";
import { db } from "@/lib/db";
import type { PracticeRun, Question, QuestionType } from "@/lib/types";

const TYPE_ORDER: QuestionType[] = ["单选", "多选", "判断"];

function runStats(run: PracticeRun) {
  const submitted = Object.values(run.answers).filter((answer) => answer.submitted);
  const correct = submitted.filter((answer) => answer.correct).length;
  return { answered: submitted.length, correct, wrong: submitted.length - correct, accuracy: submitted.length ? Math.round(correct / submitted.length * 100) : 0 };
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

const statusText: Record<PracticeRun["status"], string> = { in_progress: "进行中", completed: "已完成", abandoned: "已放弃" };

export function PracticeHistory({ onOpen, onContinue }: { onOpen: (runId: string) => void; onContinue: () => void }) {
  const runs = useLiveQuery(() => db.practiceRuns.orderBy("startedAt").reverse().toArray(), []) ?? [];
  const [status, setStatus] = useState<"all" | PracticeRun["status"]>("all");
  const visible = status === "all" ? runs : runs.filter((run) => run.status === status);
  return <section className="practice-history-card">
    <header><div><span className="section-kicker">每次练习都有迹可循</span><h2>练习记录</h2><p>进行中、已完成和已放弃的练习都会保留。</p></div><History size={24} /></header>
    <div className="history-filters">{(["all", "in_progress", "completed", "abandoned"] as const).map((item) => <button key={item} className={status === item ? "active" : ""} onClick={() => setStatus(item)}>{item === "all" ? "全部" : statusText[item]}<span>{item === "all" ? runs.length : runs.filter((run) => run.status === item).length}</span></button>)}</div>
    {visible.length ? <div className="history-list">{visible.map((run) => { const stats = runStats(run); return <article key={run.id}>
      <button onClick={() => onOpen(run.id)}><div className="history-title"><span className={`run-status ${run.status}`}>{statusText[run.status]}</span><strong>{run.modeLabel}</strong><small>{formatTime(run.startedAt)}</small></div><h3>{run.bankName}</h3><div className="history-metrics"><span><b>{stats.answered}</b> / {run.questionIds.length} 已作答</span><span><b>{stats.accuracy}%</b> 正确率</span><span>{stats.correct} 对 · {stats.wrong} 错</span></div><ChevronRight size={18} /></button>
      {run.status === "in_progress" && <button className="history-continue" onClick={onContinue}><Play size={15} />继续练习</button>}
    </article>; })}</div> : <div className="history-empty"><Clock3 /><h3>这里还没有记录</h3><p>开始一组练习后，会立即建立可恢复的练习记录。</p></div>}
  </section>;
}

export function PracticeRunResult({ runId, onBack, onReview, onRepeat }: { runId: string; onBack: () => void; onReview?: (index: number) => void; onRepeat: (questions: Question[], label: string) => void }) {
  const data = useLiveQuery(async () => {
    const run = await db.practiceRuns.get(runId);
    if (!run) return undefined;
    return { run, questions: (await db.questions.bulkGet(run.questionIds)).filter((question): question is Question => Boolean(question)) };
  }, [runId]);
  const [filter, setFilter] = useState<"all" | "wrong" | "unanswered">("all");
  const ordered = useMemo(() => {
    if (!data) return [];
    const index = new Map(data.run.questionIds.map((id, itemIndex) => [id, itemIndex]));
    return TYPE_ORDER.flatMap((type) => data.questions.filter((question) => question.type === type).sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0)));
  }, [data]);
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
  const originalIndex = new Map(run.questionIds.map((id, index) => [id, index]));
  return <section className="run-result">
    <header><button className="back-link" onClick={onBack}><ArrowLeft size={16} />返回练习记录</button><span className={`run-status ${run.status}`}>{statusText[run.status]}</span><h1>{run.modeLabel}</h1><p>{run.bankName} · {formatTime(run.startedAt)}</p></header>
    <div className="result-score"><div><strong>{stats.accuracy}<small>%</small></strong><span>本次正确率</span></div><div className="result-score-grid"><span><b>{run.questionIds.length}</b>计划题目</span><span><b>{stats.answered}</b>已作答</span><span className="correct"><b>{stats.correct}</b>正确</span><span className="wrong"><b>{stats.wrong}</b>错误</span></div></div>
    <div className="result-actions"><button className="primary" onClick={() => onRepeat(ordered, `重练 · ${run.modeLabel}`)}><RotateCcw size={16} />重练本次题目</button>{onReview && <button onClick={() => onReview(Math.max(0, run.questionIds.findIndex((id) => !run.answers[id]?.submitted)))}><BookOpenCheck size={16} />回到本次练习</button>}</div>
    <div className="result-filters">{(["all", "wrong", "unanswered"] as const).map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "all" ? "全部题目" : item === "wrong" ? "只看错题" : "只看未答"}</button>)}</div>
    <div className="result-question-groups">{TYPE_ORDER.map((type) => { const questions = visible.filter((question) => question.type === type); if (!questions.length) return null; return <section key={type}><header><h2>{type}</h2><span>{questions.length} 题</span></header><div>{questions.map((question) => { const answer = run.answers[question.id]; const state = !answer?.submitted ? "unanswered" : answer.correct ? "correct" : "wrong"; return <button key={question.id} onClick={() => onReview?.(originalIndex.get(question.id) ?? 0)} disabled={!onReview}><span className={`result-state ${state}`}>{state === "correct" ? <CheckCircle2 /> : state === "wrong" ? <XCircle /> : <Clock3 />}</span><span><strong>{(originalIndex.get(question.id) ?? 0) + 1}. {question.stem}</strong><small>{state === "unanswered" ? "未作答" : `你的答案：${answer.selected.length ? [...answer.selected].sort().join("") : "不会"} · 正确答案：${question.answer}`}</small></span><ChevronRight size={16} /></button>; })}</div></section>; })}</div>
  </section>;
}
