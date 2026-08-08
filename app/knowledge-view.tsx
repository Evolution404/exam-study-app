"use client";

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowRight, BarChart3, Check, ChevronRight, GitBranch, Link2, Merge,
  Pencil, Play, Search, Tags, Trash2, Unlink, X,
} from "lucide-react";
import { db, deleteRelation, saveRelation, updateQuestion } from "@/lib/db";
import { summarizeAttempts } from "@/lib/practice-metrics";
import type { Question, Relation } from "@/lib/types";

const RELATION_TYPES: Relation["type"][] = ["易混", "相似", "前置", "重复"];

export function KnowledgeView({ initialQuestionId, onStartTag, onStartQuestions, onNotice }: {
  initialQuestionId?: string;
  onStartTag: (tag: string) => void;
  onStartQuestions: (questions: Question[], label: string) => void;
  onNotice: (message: string) => void;
}) {
  const [tab, setTab] = useState<"tags" | "relations">(initialQuestionId ? "relations" : "tags");
  return <>
    <div className="page-heading compact"><div><p className="eyebrow">自己的知识结构</p><h1>知识整理</h1><p>管理用户标签，并建立易混、相似、前置和重复题目关系。</p></div></div>
    <div className="knowledge-tabs"><button className={tab === "tags" ? "active" : ""} onClick={() => setTab("tags")}><Tags size={17} />标签视图</button><button className={tab === "relations" ? "active" : ""} onClick={() => setTab("relations")}><GitBranch size={17} />题目关联</button></div>
    {tab === "tags" ? <TagWorkspace onStart={onStartTag} onNotice={onNotice} /> : <RelationWorkspace initialQuestionId={initialQuestionId} onStart={onStartQuestions} onNotice={onNotice} />}
  </>;
}

function TagWorkspace({ onStart, onNotice }: { onStart: (tag: string) => void; onNotice: (message: string) => void }) {
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string>();
  const [renameValue, setRenameValue] = useState("");
  const data = useLiveQuery(async () => ({ questions: await db.questions.toArray(), attempts: await db.attempts.toArray() }), []);
  const tags = useMemo(() => {
    const questions = data?.questions ?? [];
    const attempts = data?.attempts ?? [];
    const attemptsByQuestion = new Map<string, typeof attempts>();
    attempts.forEach((attempt) => {
      const rows = attemptsByQuestion.get(attempt.questionId) ?? [];
      rows.push(attempt);
      attemptsByQuestion.set(attempt.questionId, rows);
    });
    const names = [...new Set(questions.flatMap((question) => question.tags))];
    return names.map((name) => {
      const tagged = questions.filter((question) => question.tags.includes(name));
      const rows = tagged.flatMap((question) => attemptsByQuestion.get(question.id) ?? []);
      const summary = summarizeAttempts(rows);
      const difficulty = tagged.length ? Math.round(tagged.reduce((total, question) => total + summarizeAttempts(attemptsByQuestion.get(question.id) ?? []).difficulty, 0) / tagged.length) : 50;
      return { name, questions: tagged, count: tagged.length, accuracy: summary.total ? Math.round(summary.correct / summary.total * 100) : 0, difficulty };
    }).filter((item) => item.name.toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN"))).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
  }, [data, query]);
  const selected = tags.find((item) => item.name === activeTag);

  async function replaceTag(from: string, to?: string) {
    const targets = (data?.questions ?? []).filter((question) => question.tags.includes(from));
    await Promise.all(targets.map((question) => updateQuestion(question.id, {
      stem: question.stem,
      options: question.options,
      answer: question.answer,
      type: question.type,
      tags: to ? [...new Set(question.tags.map((tag) => tag === from ? to : tag))] : question.tags.filter((tag) => tag !== from),
    })));
    setActiveTag(undefined);
    setRenameValue("");
    onNotice(to ? `标签“${from}”已整理为“${to}”` : `标签“${from}”已从 ${targets.length} 道题移除`);
  }

  return <div className="tag-workspace"><section className="tag-browser"><header><div className="knowledge-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索用户标签" /></div><span>{tags.length} 个标签</span></header>{tags.length ? <div className="tag-card-grid">{tags.map((item) => <article className={activeTag === item.name ? "active" : ""} key={item.name}><button onClick={() => { setActiveTag(item.name); setRenameValue(item.name); }}><Tags size={17} /><span><strong>{item.name}</strong><small>{item.count} 道题 · 正确率 {item.accuracy}% · 难度 {item.difficulty}</small></span><ChevronRight size={16} /></button><button className="tag-quick-practice" onClick={() => onStart(item.name)}><Play size={14} />练习</button></article>)}</div> : <div className="knowledge-empty"><Tags /><h2>还没有用户标签</h2><p>在题目详情或编辑题目时添加标签，这里会自动形成知识索引。</p></div>}</section>{selected && <aside className="tag-detail"><header><div><span className="section-kicker">标签详情</span><h2>{selected.name}</h2></div><button className="icon-button" aria-label="关闭标签详情" onClick={() => setActiveTag(undefined)}><X size={17} /></button></header><div className="tag-detail-stats"><span><strong>{selected.count}</strong>相关题目</span><span><strong>{selected.accuracy}%</strong>正确率</span><span><strong>{selected.difficulty}</strong>平均难度</span></div><label>重命名或合并标签<input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} /><small>如果目标名称已经存在，将自动合并两个标签。</small></label><div className="tag-manage-actions"><button disabled={!renameValue.trim() || renameValue.trim() === selected.name} onClick={() => void replaceTag(selected.name, renameValue.trim())}>{(data?.questions ?? []).some((question) => question.tags.includes(renameValue.trim()) && renameValue.trim() !== selected.name) ? <Merge size={16} /> : <Pencil size={16} />}{(data?.questions ?? []).some((question) => question.tags.includes(renameValue.trim()) && renameValue.trim() !== selected.name) ? "合并标签" : "保存名称"}</button><button className="danger-button" onClick={() => { if (window.confirm(`从 ${selected.count} 道题中移除标签“${selected.name}”？题目不会被删除。`)) void replaceTag(selected.name); }}><Trash2 size={16} />删除标签</button></div><button className="primary full" onClick={() => onStart(selected.name)}><Play size={17} />练习这个标签</button><div className="tag-question-preview">{selected.questions.slice(0, 12).map((question, index) => <p key={question.id}><span>{index + 1}</span>{question.stem}</p>)}{selected.questions.length > 12 && <small>还有 {selected.questions.length - 12} 道题，可通过搜索查看全部。</small>}</div></aside>}</div>;
}

function RelationWorkspace({ initialQuestionId, onStart, onNotice }: { initialQuestionId?: string; onStart: (questions: Question[], label: string) => void; onNotice: (message: string) => void }) {
  const data = useLiveQuery(async () => ({ questions: await db.questions.toArray(), relations: (await db.relations.toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }), []);
  const [sourceId, setSourceId] = useState(initialQuestionId ?? "");
  const [targetId, setTargetId] = useState("");
  const [sourceQuery, setSourceQuery] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [type, setType] = useState<Relation["type"]>("易混");
  const [expandedId, setExpandedId] = useState<string>();
  const questions = data?.questions ?? [];
  const byId = new Map(questions.map((question) => [question.id, question]));
  const findQuestions = (value: string, excludeId?: string) => value.trim() ? questions.filter((question) => question.id !== excludeId && [question.stem, question.bankName, ...question.tags].join(" ").toLocaleLowerCase("zh-CN").includes(value.trim().toLocaleLowerCase("zh-CN"))).slice(0, 6) : [];
  const source = byId.get(sourceId);
  const target = byId.get(targetId);

  async function create() {
    if (!source || !target) return;
    const exists = (data?.relations ?? []).some((relation) => relation.fromQuestionId === source.id && relation.toQuestionId === target.id && relation.type === type);
    if (exists) { onNotice("这组题目已经存在相同关联"); return; }
    await saveRelation(source.id, target.id, type);
    setSourceId(""); setTargetId(""); setSourceQuery(""); setTargetQuery("");
    onNotice(`已建立“${type}”关联`);
  }

  return <div className="relation-workspace"><section className="relation-creator"><header><Link2 size={19} /><div><strong>建立题目关联</strong><p>分别搜索两道题，再选择关系类型。</p></div></header><div className="relation-picker-grid"><QuestionPicker label="当前题目" query={sourceQuery || source?.stem || ""} selected={source} results={findQuestions(sourceQuery, targetId)} onQuery={(value) => { setSourceQuery(value); setSourceId(""); }} onSelect={(question) => { setSourceId(question.id); setSourceQuery(question.stem); }} /><ArrowRight className="relation-arrow" /><QuestionPicker label="关联题目" query={targetQuery} selected={target} results={findQuestions(targetQuery, sourceId)} onQuery={(value) => { setTargetQuery(value); setTargetId(""); }} onSelect={(question) => { setTargetId(question.id); setTargetQuery(question.stem); }} /></div><div className="relation-create-footer"><label>关系类型<select value={type} onChange={(event) => setType(event.target.value as Relation["type"])}>{RELATION_TYPES.map((item) => <option key={item}>{item}</option>)}</select></label><button className="primary" disabled={!source || !target} onClick={() => void create()}><Link2 size={16} />保存关联</button></div></section><section className="relation-list"><header><div><span className="section-kicker">已建立关系</span><h2>{data?.relations.length ?? 0} 组题目关联</h2></div></header>{data?.relations.length ? <div>{data.relations.map((relation) => { const from = byId.get(relation.fromQuestionId); const to = byId.get(relation.toQuestionId); if (!from || !to) return null; const expanded = expandedId === relation.id; return <article key={relation.id}><div className="relation-summary"><button className="relation-question" onClick={() => setExpandedId(expanded ? undefined : relation.id)}><span>A</span><strong>{from.stem}</strong></button><select aria-label="关系类型" value={relation.type} onChange={(event) => void saveRelation(from.id, to.id, event.target.value as Relation["type"], relation.id)}>{RELATION_TYPES.map((item) => <option key={item}>{item}</option>)}</select><button className="relation-question" onClick={() => setExpandedId(expanded ? undefined : relation.id)}><span>B</span><strong>{to.stem}</strong></button></div><footer><button onClick={() => setExpandedId(expanded ? undefined : relation.id)}><BarChart3 size={15} />{expanded ? "收起对比" : "对比题目"}</button><button onClick={() => onStart([from, to], `${relation.type}题组`)}><Play size={15} />练习这组</button><button className="relation-delete" onClick={() => { if (window.confirm("删除这组题目关联？题目本身不会被删除。")) void deleteRelation(relation.id); }}><Unlink size={15} />删除关联</button></footer>{expanded && <div className="relation-compare"><QuestionCompare label="题目 A" question={from} /><QuestionCompare label="题目 B" question={to} /></div>}</article>; })}</div> : <div className="knowledge-empty"><GitBranch /><h2>还没有题目关联</h2><p>从上方搜索两道题，建立第一组易混、相似、前置或重复关系。</p></div>}</section></div>;
}

function QuestionPicker({ label, query, selected, results, onQuery, onSelect }: { label: string; query: string; selected?: Question; results: Question[]; onQuery: (value: string) => void; onSelect: (question: Question) => void }) {
  return <label className="relation-picker"><span>{label}</span><div><Search size={15} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="输入题干、题库或标签" />{selected && <Check size={15} />}</div>{!selected && results.length > 0 && <div className="relation-picker-results">{results.map((question) => <button type="button" key={question.id} onClick={() => onSelect(question)}><strong>{question.stem}</strong><small>{question.type} · {question.bankName}</small></button>)}</div>}</label>;
}

function QuestionCompare({ label, question }: { label: string; question: Question }) {
  return <section><span>{label} · {question.type}</span><h3>{question.stem}</h3><ol>{question.options.map((option, index) => <li className={question.answer.includes(String.fromCharCode(65 + index)) ? "answer" : ""} key={`${option}-${index}`}>{String.fromCharCode(65 + index)}. {option}</li>)}</ol></section>;
}
