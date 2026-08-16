import { useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, BookOpenCheck, Check, CheckCircle2, ChevronRight, Clock3, History, Play, RotateCcw, Trash2, X, XCircle } from "lucide-react";
import { dbV7 } from "@/lib/db/db-v7";
import { MathText } from "@/app/ui/math-text";
import { NoteMarkdown } from "@/app/ui/note-markdown";
import { ContentBlockRenderer } from "@/app/bank/content-block-renderer";
import { ModalPortal } from "@/app/ui/modal-portal";
import { Hint } from "@/app/ui/hint";
import { loadImageAssetV7, toQuestionViewModel, type QuestionViewModel } from "@/app/bank/question-editor";
import type { PracticeRunV7, QuestionTypeV7 } from "@/lib/db/v7-types";

const TYPE_ORDER: QuestionTypeV7[] = ["单选", "多选", "判断", "计算"];

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
      <button type="button" className={run.status === "in_progress" ? "history-open has-actions" : "history-open"} onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } if (offset < 0) { setOffset(0); return; } onOpen(run.id); }}><div className="history-title"><span className={`run-status ${run.status}`}>{statusText[run.status]}</span><strong>{run.modeLabel}</strong><small>{formatTime(run.startedAt)}</small></div><h3>{run.bankName}</h3><div className="history-metrics"><span><b>{stats.answered}</b> / {run.questionIds.length} 已作答</span><span><b>{stats.accuracy}%</b> 正确率</span><span>{stats.correct} 对 · {stats.wrong} 错</span></div>{run.status !== "in_progress" && <ChevronRight size={18} />}</button>
      {run.status === "in_progress" && <div className="history-card-actions"><Hint label="继续练习"><button type="button" aria-label="继续练习" onClick={() => onContinue(run.id)}><Play size={15} fill="currentColor" /></button></Hint><Hint label="放弃练习"><button type="button" className="abandon" aria-label="放弃练习" onClick={() => onAbandon(run.id)}><XCircle size={16} /></button></Hint></div>}
    </div>
  </article>;
}

export function PracticeHistory({ onOpen, onContinue, onAbandon, onDelete }: { onOpen: (runId: string) => void; onContinue: (runId: string) => void; onAbandon: (runId: string) => void; onDelete: (runId: string) => void }) {
  const runs = useLiveQuery(() => dbV7.practiceRuns.orderBy("startedAt").reverse().toArray(), []) ?? [];
  const [status, setStatus] = useState<"all" | PracticeRunV7["status"]>("all");
  const visible = status === "all" ? runs : runs.filter((run) => run.status === status);
  return <section className="practice-history-card">
    <header><div><span className="section-kicker">每次练习都有迹可循</span><h2>练习记录</h2><p>进行中、已完成和已放弃的练习都会保留。</p></div><History size={24} /></header>
    <div className="history-filters">{(["all", "in_progress", "completed", "abandoned"] as const).map((item) => <button key={item} className={status === item ? "active" : ""} onClick={() => setStatus(item)}>{item === "all" ? "全部" : statusText[item]}<span>{item === "all" ? runs.length : runs.filter((run) => run.status === item).length}</span></button>)}</div>
    {visible.length ? <div className="history-list">{visible.map((run) => <HistoryRunCard key={run.id} run={run} onOpen={onOpen} onContinue={onContinue} onAbandon={onAbandon} onDelete={onDelete} />)}</div> : <div className="history-empty"><Clock3 /><h3>这里还没有记录</h3><p>开始一组练习后，会立即建立可恢复的练习记录。</p></div>}
  </section>;
}

export function PracticeRunResult({ runId, onBack, onContinue, onRepeat }: { runId: string; onBack: () => void; onContinue?: (runId: string, index: number) => void; onRepeat: (questions: QuestionViewModel[], label: string, previousOptionOrders: Record<string, number[]>) => void }) {
  const data = useLiveQuery(async () => {
    const run = await dbV7.practiceRuns.get(runId);
    if (!run) return undefined;
    const questions = (await dbV7.questions.bulkGet(run.questionIds)).filter(Boolean);
    const memberships = await dbV7.bankQuestionMemberships.toArray();
    const banks = await dbV7.banks.toArray();
    return { run, questions: questions.map((question) => { const membership = memberships.find((item) => item.questionId === question!.id); const bank = banks.find((item) => item.id === membership?.bankId); return toQuestionViewModel(question!, membership?.bankId, bank?.displayName || bank?.name || "未归档题目", membership?.sortOrder ?? 0); }) };
  }, [runId]);
  const [filter, setFilter] = useState<"all" | "wrong" | "unanswered">("all");
  const [detailQuestion, setDetailQuestion] = useState<QuestionViewModel>();
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
  const wrongQuestions = ordered.filter((question) => run.answers[question.id]?.submitted && !run.answers[question.id]?.correct);
  const originalIndex = new Map(run.questionIds.map((id, index) => [id, index]));
  return <section className="run-result">
    <header><button className="back-link" onClick={onBack}><ArrowLeft size={16} />返回练习记录</button><span className={`run-status ${run.status}`}>{statusText[run.status]}</span><h1>{run.modeLabel}</h1><p>{run.bankName} · {formatTime(run.startedAt)}</p></header>
    <div className="result-score"><div><strong>{stats.accuracy}<small>%</small></strong><span>本次正确率</span></div><div className="result-score-grid"><span><b>{run.questionIds.length}</b>计划题目</span><span><b>{stats.answered}</b>已作答</span><span className="correct"><b>{stats.correct}</b>正确</span><span className="wrong"><b>{stats.wrong}</b>错误</span></div></div>
    <div className="result-actions"><button className="primary" onClick={() => onRepeat(ordered, `重练 · ${run.modeLabel}`, run.optionOrders)}><RotateCcw size={16} />重练本次题目</button>{wrongQuestions.length > 0 && <button onClick={() => onRepeat(wrongQuestions, `集中重练 ${wrongQuestions.length} 道错题`, run.optionOrders)}><XCircle size={16} />只练本次错题</button>}{run.status === "in_progress" && onContinue && <button onClick={() => onContinue(run.id, Math.max(0, run.questionIds.findIndex((id) => !run.answers[id]?.submitted)))}><BookOpenCheck size={16} />继续本次练习</button>}</div>
    <div className="result-filters">{(["all", "wrong", "unanswered"] as const).map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "all" ? "全部题目" : item === "wrong" ? "只看错题" : "只看未答"}</button>)}</div>
    <div className="result-question-groups">{TYPE_ORDER.map((type) => { const questions = visible.filter((question) => question.type === type); if (!questions.length) return null; return <section key={type}><header><h2>{type}</h2><span>{questions.length} 题</span></header><div>{questions.map((question) => { const answer = run.answers[question.id]; const state = !answer?.submitted ? "unanswered" : answer.correct ? "correct" : "wrong"; return <button key={question.id} aria-label={`查看第 ${(originalIndex.get(question.id) ?? 0) + 1} 题详情`} onClick={() => setDetailQuestion(question)}><span className={`result-state ${state}`}>{state === "correct" ? <CheckCircle2 /> : state === "wrong" ? <XCircle /> : <Clock3 />}</span><span><strong>{(originalIndex.get(question.id) ?? 0) + 1}. <MathText text={question.stem} /></strong><small>{state === "unanswered" ? "未作答" : `正确答案：${question.answer} · 你的答案：${answer.selected.length ? question.type === "计算" ? answer.selected[0] : [...answer.selected].sort().join("") : "不会"}`}</small></span><ChevronRight size={16} /></button>; })}</div></section>; })}</div>
    {detailQuestion && <ResultQuestionDetail question={detailQuestion} answer={run.answers[detailQuestion.id]} onClose={() => setDetailQuestion(undefined)} />}
  </section>;
}

function ResultQuestionDetail({ question, answer, onClose }: { question: QuestionViewModel; answer?: PracticeRunV7["answers"][string]; onClose: () => void }) {
  const note = useLiveQuery(() => dbV7.notes.get(question.id), [question.id]);
  return <ModalPortal><div className="search-detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="search-question-detail result-question-detail" role="dialog" aria-modal="true" aria-label="练习结果题目详情"><header><div><span className="section-kicker">练习结果详情</span><h2>{question.type} · {question.bankName}</h2></div><button className="icon-button" aria-label="关闭题目详情" onClick={onClose}><X size={18} /></button></header><div className="search-detail-body"><ContentBlockRenderer blocks={question.canonical.content} loadAsset={loadImageAssetV7} />{question.type !== "计算" && <ol>{question.canonical.options.map((option, index) => { const letter = String.fromCharCode(65 + index); return <li className={question.answer.includes(letter) ? "answer" : ""} key={`${option}-${index}`}><span>{letter}</span><ContentBlockRenderer blocks={option} loadAsset={loadImageAssetV7} />{question.answer.includes(letter) && <Check size={16} />}</li>; })}</ol>}<section className="search-answer-card"><strong>正确答案：{question.answer}</strong><p>你的答案：{answer?.submitted ? answer.selected.length ? question.type === "计算" ? answer.selected[0] : [...answer.selected].sort().join("") : "不会" : "未作答"}</p></section><section className="search-detail-note"><strong>个人解析</strong>{note?.content ? <NoteMarkdown text={note.content} /> : <p>还没有个人解析。</p>}</section></div></aside></div></ModalPortal>;
}
