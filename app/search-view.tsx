"use client";

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Check, ChevronRight, CircleAlert, Filter, GitBranch, History, ListChecks, LoaderCircle,
  Pencil, Play, Search, Star, Tags, X,
} from "lucide-react";
import { QuestionEditor, type QuestionChanges } from "@/app/question-editor";
import { MathText } from "@/app/math-text";
import { db, toggleQuestionFavorite, updateQuestion } from "@/lib/db";
import { difficultyLabel, needsWrongReview, summarizeAttempts } from "@/lib/practice-metrics";
import type { Bank, Question, QuestionType } from "@/lib/types";

const TYPE_ORDER: QuestionType[] = ["单选", "多选", "判断"];
type TypeTab = "全部" | QuestionType;
type SearchStatus = "all" | "unanswered" | "wrong" | "favorite";
type NoteFilter = "all" | "with" | "without";

export interface SearchPracticeOptions {
  questions: Question[];
  label: string;
  shuffleOptions: boolean;
}

function numberOrNull(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function shuffle<T>(values: T[]) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function loadSearchHistory() {
  if (typeof window === "undefined") return [];
  try {
    const history = JSON.parse(localStorage.getItem("study-search-history") ?? "[]") as unknown;
    return Array.isArray(history) ? history.filter((item): item is string => typeof item === "string").slice(0, 10) : [];
  } catch {
    return [];
  }
}

function answerText(question: Question) {
  return question.answer.split("").map((letter) => {
    const index = letter.charCodeAt(0) - 65;
    return `${letter}. ${question.options[index] ?? ""}`;
  }).join("；");
}

export function SearchView({
  query,
  onQueryChange,
  banks,
  currentBankIds,
  focusQuestionId,
  onFocusHandled,
  wrongRemovalStreak,
  defaultShuffleOptions,
  hasActiveSession,
  onStart,
  onGroup,
  onNotice,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  banks: Bank[];
  currentBankIds: string[];
  focusQuestionId?: string;
  onFocusHandled: () => void;
  wrongRemovalStreak: number;
  defaultShuffleOptions: boolean;
  hasActiveSession: boolean;
  onStart: (options: SearchPracticeOptions) => Promise<void>;
  onGroup: (questionIds: string[]) => void;
  onNotice: (message: string) => void;
}) {
  const [scope, setScope] = useState<"current" | "all">(currentBankIds.length ? "current" : "all");
  const [bankId, setBankId] = useState("all");
  const [typeTab, setTypeTab] = useState<TypeTab>("全部");
  const [keywordMode, setKeywordMode] = useState<"plain" | "regex">("regex");
  const [status, setStatus] = useState<SearchStatus>("all");
  const [tag, setTag] = useState("all");
  const [noteFilter, setNoteFilter] = useState<NoteFilter>("all");
  const [difficultyMin, setDifficultyMin] = useState("");
  const [difficultyMax, setDifficultyMax] = useState("");
  const [attemptsMin, setAttemptsMin] = useState("");
  const [attemptsMax, setAttemptsMax] = useState("");
  const [wrongMin, setWrongMin] = useState("");
  const [wrongMax, setWrongMax] = useState("");
  const [lastFrom, setLastFrom] = useState("");
  const [lastTo, setLastTo] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(50);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [detailQuestionId, setDetailQuestionId] = useState<string | undefined>(focusQuestionId);
  const [practiceSource, setPracticeSource] = useState<{ questions: Question[]; label: string }>();
  const [batchTag, setBatchTag] = useState("");
  const [history, setHistory] = useState(loadSearchHistory);

  const scopedBankIds = bankId !== "all"
    ? [bankId]
    : scope === "all"
      ? banks.map((bank) => bank.id)
      : currentBankIds;
  const bankKey = scopedBankIds.join("|");
  const data = useLiveQuery(async () => {
    const [questions, attempts, notes] = await Promise.all([
      Promise.all(scopedBankIds.map((id) => db.questions.where("bankId").equals(id).toArray())).then((rows) => rows.flat()),
      Promise.all(scopedBankIds.map((id) => db.attempts.where("bankId").equals(id).toArray())).then((rows) => rows.flat()),
      db.notes.toArray(),
    ]);
    return { questions, attempts, notes };
  }, [bankKey]);

  const tags = useMemo(() => [...new Set((data?.questions ?? []).flatMap((question) => question.tags))].sort((a, b) => a.localeCompare(b, "zh-CN")), [data?.questions]);
  const result = useMemo(() => {
    const questions = data?.questions ?? [];
    const attempts = data?.attempts ?? [];
    const notes = data?.notes ?? [];
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return { entries: [] as Array<{ question: Question; metric: ReturnType<typeof summarizeAttempts>; hasNote: boolean }>, counts: { 单选: 0, 多选: 0, 判断: 0 }, error: "" };
    let pattern: RegExp | null = null;
    if (keywordMode === "regex") {
      try { pattern = new RegExp(query.trim(), "i"); } catch { return { entries: [], counts: { 单选: 0, 多选: 0, 判断: 0 }, error: "正则表达式格式不正确" }; }
    }
    const notesByQuestion = new Map(notes.map((note) => [note.questionId, note.content]));
    const attemptsByQuestion = new Map<string, typeof attempts>();
    attempts.forEach((attempt) => {
      const rows = attemptsByQuestion.get(attempt.questionId) ?? [];
      rows.push(attempt);
      attemptsByQuestion.set(attempt.questionId, rows);
    });
    const minDifficulty = numberOrNull(difficultyMin);
    const maxDifficulty = numberOrNull(difficultyMax);
    const minAttempts = numberOrNull(attemptsMin);
    const maxAttempts = numberOrNull(attemptsMax);
    const minWrong = numberOrNull(wrongMin);
    const maxWrong = numberOrNull(wrongMax);
    const fromTime = lastFrom ? new Date(`${lastFrom}T00:00:00`).getTime() : null;
    const toTime = lastTo ? new Date(`${lastTo}T23:59:59.999`).getTime() : null;
    const base = questions.flatMap((question) => {
      const rows = attemptsByQuestion.get(question.id) ?? [];
      const metric = summarizeAttempts(rows);
      const note = notesByQuestion.get(question.id) ?? "";
      const searchable = [question.stem, ...question.options, ...question.tags, note].join("\n");
      const keywordMatches = pattern ? pattern.test(searchable) : searchable.toLocaleLowerCase("zh-CN").includes(normalized);
      if (!keywordMatches) return [];
      if (tag !== "all" && !question.tags.includes(tag)) return [];
      if (status === "unanswered" && metric.total) return [];
      if (status === "wrong" && !needsWrongReview(rows, wrongRemovalStreak)) return [];
      if (status === "favorite" && !question.favorite) return [];
      if (noteFilter === "with" && !note.trim()) return [];
      if (noteFilter === "without" && note.trim()) return [];
      if (minDifficulty !== null && metric.difficulty < minDifficulty) return [];
      if (maxDifficulty !== null && metric.difficulty > maxDifficulty) return [];
      if (minAttempts !== null && metric.total < minAttempts) return [];
      if (maxAttempts !== null && metric.total > maxAttempts) return [];
      if (minWrong !== null && metric.wrong < minWrong) return [];
      if (maxWrong !== null && metric.wrong > maxWrong) return [];
      if ((fromTime !== null || toTime !== null) && metric.latest === null) return [];
      if (fromTime !== null && metric.latest !== null && metric.latest < fromTime) return [];
      if (toTime !== null && metric.latest !== null && metric.latest > toTime) return [];
      return [{ question, metric, hasNote: Boolean(note.trim()) }];
    });
    const counts = {
      单选: base.filter((entry) => entry.question.type === "单选").length,
      多选: base.filter((entry) => entry.question.type === "多选").length,
      判断: base.filter((entry) => entry.question.type === "判断").length,
    };
    const filtered = typeTab === "全部" ? base : base.filter((entry) => entry.question.type === typeTab);
    return { entries: TYPE_ORDER.flatMap((type) => filtered.filter((entry) => entry.question.type === type)), counts, error: "" };
  }, [data, query, keywordMode, tag, status, noteFilter, difficultyMin, difficultyMax, attemptsMin, attemptsMax, wrongMin, wrongMax, lastFrom, lastTo, typeTab, wrongRemovalStreak]);

  const visibleEntries = result.entries.slice(0, visibleCount);
  const selectedQuestions = result.entries.filter((entry) => selectedIds.includes(entry.question.id)).map((entry) => entry.question);
  const allSelected = result.entries.length > 0 && result.entries.every((entry) => selectedIds.includes(entry.question.id));

  async function favoriteSelected() {
    const targets = selectedQuestions.filter((question) => !question.favorite);
    await Promise.all(targets.map((question) => toggleQuestionFavorite(question.id)));
    onNotice(`已收藏 ${targets.length} 道题`);
  }

  async function addTagToSelected() {
    const nextTag = batchTag.trim();
    if (!nextTag) return;
    await Promise.all(selectedQuestions.map((question) => updateQuestion(question.id, {
      stem: question.stem,
      options: question.options,
      answer: question.answer,
      type: question.type,
      tags: [...new Set([...question.tags, nextTag])],
    })));
    setBatchTag("");
    onNotice(`已给 ${selectedQuestions.length} 道题添加标签“${nextTag}”`);
  }

  function clearHistory() {
    setHistory([]);
    localStorage.removeItem("study-search-history");
  }

  return <div className="search-page">
    <div className="search-page-heading"><div><p className="eyebrow">查题、筛选与整理</p><h1>搜索题库</h1><p>{query.trim() ? result.error || `“${query.trim()}”找到 ${result.counts.单选 + result.counts.多选 + result.counts.判断} 道题` : "默认使用正则表达式，可组合题库、作答情况、标签、难度和日期筛选。"}</p></div><div className="search-heading-actions"><label>搜索范围<select value={scope} onChange={(event) => { setScope(event.target.value as "current" | "all"); setBankId("all"); }}><option value="current">首页已选题库</option><option value="all">全部题库</option></select></label><label>指定题库<select value={bankId} onChange={(event) => setBankId(event.target.value)}><option value="all">不指定</option>{banks.filter((bank) => scope === "all" || currentBankIds.includes(bank.id)).map((bank) => <option key={bank.id} value={bank.id}>{bank.displayName || bank.name}</option>)}</select></label></div></div>
    <section className="search-home-query"><Search size={20} /><input aria-label="搜索题库" value={query} onChange={(event) => { onQueryChange(event.target.value); setVisibleCount(50); }} placeholder="正则示例：弧垂|导线，普通文字也可直接输入" /><button className={`search-filter-toggle ${advancedOpen ? "active" : ""}`} onClick={() => setAdvancedOpen(!advancedOpen)}><Filter size={16} />高级条件</button></section>
    {query.trim() && <section className="search-toolbar"><div className="search-type-tabs">{(["全部", ...TYPE_ORDER] as TypeTab[]).map((type) => <button key={type} className={typeTab === type ? "active" : ""} onClick={() => { setTypeTab(type); setVisibleCount(50); }}>{type}<span>{type === "全部" ? result.counts.单选 + result.counts.多选 + result.counts.判断 : result.counts[type]}</span></button>)}</div></section>}
    {advancedOpen && <section className="search-filter-panel"><label>关键词方式<select value={keywordMode} onChange={(event) => setKeywordMode(event.target.value as "plain" | "regex")}><option value="plain">包含关键词</option><option value="regex">正则表达式</option></select></label><label>作答状态<select value={status} onChange={(event) => setStatus(event.target.value as SearchStatus)}><option value="all">全部</option><option value="unanswered">从未作答</option><option value="wrong">当前错题</option><option value="favorite">已收藏</option></select></label><label>用户标签<select value={tag} onChange={(event) => setTag(event.target.value)}><option value="all">全部标签</option>{tags.map((item) => <option key={item}>{item}</option>)}</select></label><label>个人解析<select value={noteFilter} onChange={(event) => setNoteFilter(event.target.value as NoteFilter)}><option value="all">不限</option><option value="with">已有解析</option><option value="without">没有解析</option></select></label><label>最低难度<input type="number" min="0" max="100" value={difficultyMin} onChange={(event) => setDifficultyMin(event.target.value)} placeholder="不限" /></label><label>最高难度<input type="number" min="0" max="100" value={difficultyMax} onChange={(event) => setDifficultyMax(event.target.value)} placeholder="不限" /></label><label>总作答最少<input type="number" min="0" value={attemptsMin} onChange={(event) => setAttemptsMin(event.target.value)} placeholder="不限" /></label><label>总作答最多<input type="number" min="0" value={attemptsMax} onChange={(event) => setAttemptsMax(event.target.value)} placeholder="不限" /></label><label>错误次数最少<input type="number" min="0" value={wrongMin} onChange={(event) => setWrongMin(event.target.value)} placeholder="不限" /></label><label>错误次数最多<input type="number" min="0" value={wrongMax} onChange={(event) => setWrongMax(event.target.value)} placeholder="不限" /></label><label>最后作答开始<input type="date" value={lastFrom} onInput={(event) => setLastFrom(event.currentTarget.value)} /></label><label>最后作答结束<input type="date" value={lastTo} onInput={(event) => setLastTo(event.currentTarget.value)} /></label></section>}
    {advancedOpen && (lastFrom || lastTo) && <button className="clear-search-dates" onClick={() => { setLastFrom(""); setLastTo(""); }}><X size={14} />清除作答日期</button>}
    {!query.trim() ? <section className="search-empty-page"><Search size={28} /><h2>输入关键词开始搜索</h2><p>支持普通关键词和正则表达式；搜索只读取本地题库。</p>{history.length > 0 && <div className="search-history"><header><span><History size={15} />最近搜索</span><button onClick={clearHistory}>清除</button></header><div>{history.map((item) => <button key={item} onClick={() => onQueryChange(item)}>{item}</button>)}</div></div>}</section> : data === undefined ? <div className="search-loading"><LoaderCircle className="spin" />正在读取本地题库…</div> : result.error ? <div className="search-no-result"><CircleAlert /><h2>{result.error}</h2></div> : result.entries.length ? <>
      <section className="search-batch-bar"><label><input type="checkbox" checked={allSelected} onChange={() => setSelectedIds(allSelected ? [] : result.entries.map((entry) => entry.question.id))} />选择当前 {result.entries.length} 道结果</label><span>已选择 {selectedQuestions.length} 道</span><div><button disabled={!selectedQuestions.length} onClick={() => void favoriteSelected()}><Star size={15} />收藏所选</button><span className="batch-tag"><input value={batchTag} onChange={(event) => setBatchTag(event.target.value)} placeholder="批量添加标签" /><button disabled={!selectedQuestions.length || !batchTag.trim()} onClick={() => void addTagToSelected()}><Tags size={15} />添加</button></span><button disabled={!selectedQuestions.length} onClick={() => onGroup(selectedQuestions.map((question) => question.id))}><GitBranch size={15} />加入题组</button><button disabled={!selectedQuestions.length} onClick={() => setPracticeSource({ questions: selectedQuestions, label: `搜索已选 ${selectedQuestions.length} 题` })}><ListChecks size={15} />练习已选</button><button className="primary" onClick={() => setPracticeSource({ questions: result.entries.map((entry) => entry.question), label: `搜索“${query.trim()}”` })}><Play size={15} />练习全部结果</button></div></section>
      <div className="search-result-list">{visibleEntries.map(({ question, metric, hasNote }, index) => <article key={question.id} className={selectedIds.includes(question.id) ? "selected" : ""}><label className="result-checkbox"><input type="checkbox" checked={selectedIds.includes(question.id)} onChange={() => setSelectedIds(selectedIds.includes(question.id) ? selectedIds.filter((id) => id !== question.id) : [...selectedIds, question.id])} /><span>{index + 1}</span></label><button className="search-result-main" onClick={() => setDetailQuestionId(question.id)}><div><span className="result-type">{question.type}</span><span>{question.bankName}</span>{question.tags.map((item) => <em key={item}>{item}</em>)}</div><h2><MathText text={question.stem} /></h2><p>难度 {metric.difficulty} · 作答 {metric.total} 次 · 错误 {metric.wrong} 次{hasNote ? " · 已有个人解析" : ""}</p></button><ChevronRight size={18} /></article>)}</div>
      {visibleCount < result.entries.length && <button className="search-load-more" onClick={() => setVisibleCount(visibleCount + 50)}>继续加载（已显示 {visibleEntries.length} / {result.entries.length}）</button>}
    </> : <div className="search-no-result"><Search /><h2>没有符合条件的题目</h2><p>可以缩短关键词或减少筛选条件。</p></div>}
    {detailQuestionId && <SearchQuestionDetail questionId={detailQuestionId} onClose={() => { setDetailQuestionId(undefined); onFocusHandled(); }} onStart={(question) => setPracticeSource({ questions: [question], label: "单题练习" })} onGroup={(questionId) => onGroup([questionId])} onNotice={onNotice} />}
    {practiceSource && <SearchPracticeDialog source={practiceSource} defaultShuffleOptions={defaultShuffleOptions} hasActiveSession={hasActiveSession} onClose={() => setPracticeSource(undefined)} onStart={async (options) => { await onStart(options); setPracticeSource(undefined); }} />}
  </div>;
}

function SearchQuestionDetail({ questionId, onClose, onStart, onGroup, onNotice }: { questionId: string; onClose: () => void; onStart: (question: Question) => void; onGroup: (questionId: string) => void; onNotice: (message: string) => void }) {
  const question = useLiveQuery(() => db.questions.get(questionId), [questionId]);
  const note = useLiveQuery(() => db.notes.get(questionId), [questionId]);
  const metric = useLiveQuery(async () => summarizeAttempts(await db.attempts.where("questionId").equals(questionId).toArray()), [questionId]);
  const [editing, setEditing] = useState(false);
  if (!question) return null;
  return <div className="search-detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="search-question-detail" role="dialog" aria-modal="true" aria-label="题目详情"><header><div><span className="section-kicker">题目详情</span><h2>{question.type} · {question.bankName}</h2></div><button className="icon-button" aria-label="关闭题目详情" onClick={onClose}><X size={18} /></button></header><div className="search-detail-body"><h1><MathText text={question.stem} /></h1><ol>{question.options.map((option, index) => <li className={question.answer.includes(String.fromCharCode(65 + index)) ? "answer" : ""} key={`${option}-${index}`}><span>{String.fromCharCode(65 + index)}</span><MathText text={option} />{question.answer.includes(String.fromCharCode(65 + index)) && <Check size={16} />}</li>)}</ol><section className="search-answer-card"><strong>正确答案：{question.answer}</strong><p><MathText text={answerText(question)} /></p></section><div className="search-detail-metrics"><span><strong>{metric?.total ?? 0}</strong>作答</span><span><strong>{metric?.correct ?? 0}</strong>正确</span><span><strong>{metric?.wrong ?? 0}</strong>错误</span><span><strong>{metric?.difficulty ?? 50}</strong>难度 · {difficultyLabel(metric?.difficulty ?? 50)}</span></div><section className="search-detail-note"><strong>个人解析</strong><p>{note?.content || "还没有个人解析，可以通过编辑题目或练习页面继续整理。"}</p></section>{question.tags.length > 0 && <div className="search-detail-tags">{question.tags.map((item) => <span key={item}>{item}</span>)}</div>}</div><footer><button onClick={async () => { const updated = await toggleQuestionFavorite(question.id); onNotice(updated.favorite ? "已收藏这道题" : "已取消收藏"); }}><Star size={16} fill={question.favorite ? "currentColor" : "none"} />{question.favorite ? "已收藏" : "收藏"}</button><button onClick={() => setEditing(true)}><Pencil size={16} />编辑题目</button><button onClick={() => onGroup(question.id)}><GitBranch size={16} />加入题组</button><button className="primary" onClick={() => onStart(question)}><Play size={16} />只练这一题</button></footer>{editing && <QuestionEditor question={question} onCancel={() => setEditing(false)} onSave={async (changes: QuestionChanges) => { await updateQuestion(question.id, changes); setEditing(false); onNotice("题目和标签已保存"); }} />}</aside></div>;
}

function SearchPracticeDialog({ source, defaultShuffleOptions, hasActiveSession, onClose, onStart }: { source: { questions: Question[]; label: string }; defaultShuffleOptions: boolean; hasActiveSession: boolean; onClose: () => void; onStart: (options: SearchPracticeOptions) => Promise<void> }) {
  const [count, setCount] = useState("");
  const [order, setOrder] = useState<"sequential" | "random">("sequential");
  const [shuffleOptions, setShuffleOptions] = useState(defaultShuffleOptions);
  const [starting, setStarting] = useState(false);
  const limit = numberOrNull(count);
  const finalCount = limit === null ? source.questions.length : Math.min(source.questions.length, Math.max(1, Math.floor(limit)));
  async function start() {
    setStarting(true);
    const ordered = TYPE_ORDER.flatMap((type) => {
      const group = source.questions.filter((question) => question.type === type);
      return order === "random" ? shuffle(group) : group;
    }).slice(0, finalCount);
    await onStart({ questions: ordered, label: source.label, shuffleOptions });
  }
  return <div className="search-practice-backdrop" role="presentation"><section className="search-practice-dialog" role="dialog" aria-modal="true" aria-label="搜索练习配置"><header><div><span className="section-kicker">确认后才进入练习</span><h2>配置搜索练习</h2></div><button className="icon-button" aria-label="关闭练习配置" onClick={onClose}><X size={18} /></button></header><div><p>共有 <strong>{source.questions.length}</strong> 道可练题目，题型始终按“单选 → 多选 → 判断”排列。</p><label>练习数量<input type="number" min="1" max={source.questions.length} value={count} onChange={(event) => setCount(event.target.value)} placeholder={`全部 ${source.questions.length} 题`} /></label><label>题型组内顺序<select value={order} onChange={(event) => setOrder(event.target.value as "sequential" | "random")}><option value="sequential">当前结果顺序</option><option value="random">组内随机</option></select></label><label className="search-dialog-toggle"><span><strong>选项顺序随机</strong><small>判断题仍保持“正确、错误”</small></span><input aria-label="选项顺序随机" type="checkbox" checked={shuffleOptions} onChange={(event) => setShuffleOptions(event.target.checked)} /></label>{hasActiveSession && <p className="search-session-warning"><CircleAlert size={16} />开始后将用本次搜索练习替换当前中断进度。</p>}</div><footer><button className="secondary-action" onClick={onClose}>取消</button><button className="primary" disabled={starting || !finalCount} onClick={() => void start()}>{starting ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}开始练习 {finalCount} 题</button></footer></section></div>;
}
