"use client";

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  BookOpenCheck, Brain, CalendarDays, Check, ChevronRight, FileUp, Filter,
  Gauge, History, Library, ListOrdered, NotebookPen, RotateCcw, Shuffle, Star,
  Tags, Target,
} from "lucide-react";
import { db } from "@/lib/db";
import { needsWrongReview, summarizeAttempts } from "@/lib/practice-metrics";
import type { Bank, QuestionType } from "@/lib/types";

export type BankQuickMode = "random30" | "sequential" | "wrong" | "favorite" | "difficult";

function fullDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

export function BankLibraryView({ banks, selectedBankIds, wrongRemovalStreak, groupSize, onToggle, onImport, onStart, onAdvanced }: {
  banks: Bank[];
  selectedBankIds: string[];
  wrongRemovalStreak: number;
  groupSize: number;
  onToggle: (bankId: string) => void;
  onImport: () => void;
  onStart: (bankId: string, mode: BankQuickMode) => void;
  onAdvanced: (bankId: string) => void;
}) {
  const [activeBankId, setActiveBankId] = useState<string | undefined>(banks[0]?.id);
  const activeBank = banks.find((bank) => bank.id === activeBankId) ?? banks[0];
  return <>
    <div className="page-heading compact"><div><p className="eyebrow">资料与练习概况</p><h1>题库</h1><p>勾选框控制首页练习范围，点击题库主体只查看详情。</p></div><button className="primary" onClick={onImport}><FileUp size={18} />导入题库</button></div>
    {banks.length ? <div className="bank-workspace"><section className="bank-master-list"><header><div><strong>我的题库</strong><span>{selectedBankIds.length ? `已选 ${selectedBankIds.length} 个` : "当前未选择"}</span></div><small>可以取消最后一个题库</small></header><div>{banks.map((bank, index) => { const selected = selectedBankIds.includes(bank.id); const active = activeBank?.id === bank.id; return <article className={`${active ? "active" : ""} ${selected ? "selected" : ""}`} key={bank.id}><button className="bank-scope-toggle" aria-label={`${selected ? "移出" : "加入"}${bank.name}的当前练习范围`} aria-pressed={selected} onClick={() => onToggle(bank.id)}>{selected && <Check size={14} />}</button><button className="bank-inspect-button" onClick={() => setActiveBankId(bank.id)}><span className={`bank-icon tone-${index % 3}`}><Library size={18} /></span><span><strong>{bank.name}</strong><small>{bank.questionCount.toLocaleString()} 题 · {fullDate(bank.importedAt)}</small></span><ChevronRight size={17} /></button></article>; })}</div></section>{activeBank && <BankDetail key={activeBank.id} groupSize={groupSize} bank={activeBank} selected={selectedBankIds.includes(activeBank.id)} wrongRemovalStreak={wrongRemovalStreak} onToggle={() => onToggle(activeBank.id)} onStart={(mode) => onStart(activeBank.id, mode)} onAdvanced={() => onAdvanced(activeBank.id)} />}</div> : <button className="empty-import" onClick={onImport}><span><FileUp size={22} /></span><div><strong>导入 JSON 题库</strong><small>数据直接写入本机，不经过第三方服务器</small></div><ChevronRight size={18} /></button>}
  </>;
}

function BankDetail({ bank, selected, wrongRemovalStreak, groupSize, onToggle, onStart, onAdvanced }: { bank: Bank; selected: boolean; wrongRemovalStreak: number; groupSize: number; onToggle: () => void; onStart: (mode: BankQuickMode) => void; onAdvanced: () => void }) {
  const data = useLiveQuery(async () => {
    const [questions, attempts, notes] = await Promise.all([
      db.questions.where("bankId").equals(bank.id).toArray(),
      db.attempts.where("bankId").equals(bank.id).toArray(),
      db.notes.toArray(),
    ]);
    return { questions, attempts, notes };
  }, [bank.id]);
  const stats = useMemo(() => {
    const questions = data?.questions ?? [];
    const attempts = data?.attempts ?? [];
    const notes = data?.notes ?? [];
    const attemptsByQuestion = new Map<string, typeof attempts>();
    attempts.forEach((attempt) => {
      const rows = attemptsByQuestion.get(attempt.questionId) ?? [];
      rows.push(attempt);
      attemptsByQuestion.set(attempt.questionId, rows);
    });
    const summaries = questions.map((question) => summarizeAttempts(attemptsByQuestion.get(question.id) ?? []));
    const correct = attempts.filter((attempt) => attempt.correct).length;
    const bankQuestionIds = new Set(questions.map((question) => question.id));
    return {
      types: Object.fromEntries((["单选", "多选", "判断"] as QuestionType[]).map((type) => [type, questions.filter((question) => question.type === type).length])) as Record<QuestionType, number>,
      answered: summaries.filter((summary) => summary.total).length,
      attempts: attempts.length,
      accuracy: attempts.length ? Math.round(correct / attempts.length * 100) : 0,
      wrong: questions.filter((question) => needsWrongReview(attemptsByQuestion.get(question.id) ?? [], wrongRemovalStreak)).length,
      favorite: questions.filter((question) => question.favorite).length,
      notes: notes.filter((note) => bankQuestionIds.has(note.questionId)).length,
      tags: new Set(questions.flatMap((question) => question.tags)).size,
      difficulty: summaries.length ? Math.round(summaries.reduce((total, summary) => total + summary.difficulty, 0) / summaries.length) : 50,
      last: attempts.length ? attempts.reduce((latest, attempt) => attempt.createdAt > latest ? attempt.createdAt : latest, attempts[0].createdAt) : undefined,
    };
  }, [data, wrongRemovalStreak]);
  return <section className="bank-detail"><header><div><span className="section-kicker">题库详情</span><h2>{bank.name}</h2><p><CalendarDays size={14} />导入时间：{fullDate(bank.importedAt)}</p></div><button className={selected ? "selected" : ""} onClick={onToggle}>{selected ? <Check size={16} /> : <Library size={16} />}{selected ? "已加入当前范围" : "加入当前范围"}</button></header><div className="bank-type-summary">{(["单选", "多选", "判断"] as QuestionType[]).map((type) => <span key={type}><strong>{stats.types[type] ?? 0}</strong>{type}</span>)}</div><div className="bank-stat-grid"><article><BookOpenCheck /><span><strong>{stats.answered} / {bank.questionCount}</strong>已作答题目</span></article><article><Target /><span><strong>{stats.accuracy}%</strong>累计正确率</span></article><article><RotateCcw /><span><strong>{stats.wrong}</strong>当前错题</span></article><article><Star /><span><strong>{stats.favorite}</strong>收藏题目</span></article><article><NotebookPen /><span><strong>{stats.notes}</strong>个人解析</span></article><article><Gauge /><span><strong>{stats.difficulty}</strong>平均难度</span></article><article><Tags /><span><strong>{stats.tags}</strong>用户标签</span></article><article><History /><span><strong>{stats.attempts}</strong>{stats.last ? `最近 ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(stats.last))}` : "尚未练习"}</span></article></div><div className="bank-practice-actions"><button className="featured" onClick={() => onStart("sequential")}><ListOrdered size={18} /><span><strong>全量顺序练习</strong><small>按题库顺序完成全部题目</small></span></button><button onClick={() => onStart("random30")}><Shuffle size={17} /><span><strong>随机 {groupSize} 题</strong><small>题型分组后组内随机</small></span></button><button disabled={!stats.wrong} onClick={() => onStart("wrong")}><RotateCcw size={17} /><span><strong>练习错题</strong><small>{stats.wrong} 道待巩固</small></span></button><button disabled={!stats.favorite} onClick={() => onStart("favorite")}><Star size={17} /><span><strong>练习收藏题</strong><small>{stats.favorite} 道已收藏</small></span></button><button onClick={() => onStart("difficult")}><Brain size={17} /><span><strong>难题优先</strong><small>按照动态难度排序</small></span></button><button onClick={onAdvanced}><Filter size={17} /><span><strong>高级筛选</strong><small>组合标签、历史和日期</small></span></button></div></section>;
}
