"use client";

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ChevronRight, CircleAlert, Filter, GitBranch, History, ListChecks, LoaderCircle,
  Pencil, Play, Search, Star, Tags, X,
} from "lucide-react";
import { SharedQuestionEditor, toQuestionViewModel, type QuestionViewModel } from "@/app/question-editor";
import { MathText } from "@/app/math-text";
import { QuestionDetail } from "@/app/question-detail";
import { dbV6, updateQuestionV6 } from "@/lib/db-v6";
import { getQuestionViewV6, listQuestionViewsForBanksV6 } from "@/lib/app-data-v6";
import { ModalPortal } from "@/app/modal-portal";
import { AppSelect } from "@/app/app-select";
import { statsNeedWrongReview, summarizeAttemptStats, type AttemptSummary } from "@/lib/practice-metrics";
import { buildScopedQuestionStats, isQuestionDoneInScope, normalizeProgressScope, scopedStatsToLegacyAttemptStats, type ProgressScope } from "@/lib/progress-scope";
import type { BankV6, QuestionTypeV6 } from "@/lib/v6-types";
type Bank = BankV6;
type Question = QuestionViewModel;
type QuestionType = QuestionTypeV6;

const TYPE_ORDER: QuestionType[] = ["单选", "多选", "判断", "计算"];
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

function scopeLabelFor(scope: ProgressScope): string {
  if (scope.type === "rolling") return `近 ${scope.days} 天`;
  if (scope.type === "lifetime") return "全部时间";
  return "当前复习轮次";
}

export function SearchView({
  query,
  onQueryChange,
  banks,
  currentBankIds,
  focusQuestionId,
  onFocusHandled,
  wrongRemovalStreak,
  progressScope = { type: "rolling", days: 90 },
  defaultShuffleOptions,
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
  progressScope?: ProgressScope;
  defaultShuffleOptions: boolean;
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
  const [searchTriggered, setSearchTriggered] = useState(false);
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
    const views = await listQuestionViewsForBanksV6(scopedBankIds);
    const bankMap = new Map(banks.map((bank) => [bank.id, bank]));
    const questions = views.map((view) => toQuestionViewModel(view.question, view.sourceBankId, bankMap.get(view.sourceBankId ?? "")?.displayName || bankMap.get(view.sourceBankId ?? "")?.name || "未归档题目", view.memberships[0]?.sortOrder ?? 0));
    const ids = new Set(questions.map((question) => question.id));
    const [rawStats, rawAttempts, notes, roundProgress] = await Promise.all([dbV6.attemptStats.toArray(), dbV6.attempts.toArray(), dbV6.notes.toArray(), dbV6.reviewRoundProgress.toArray()]);
    const attemptStats = rawStats.filter((stats) => ids.has(stats.questionId)).map((stats) => ({ ...stats, bankId: questions.find((question) => question.id === stats.questionId)?.bankId ?? "" }));
    const attempts = rawAttempts.filter((attempt) => ids.has(attempt.questionId));
    return { questions, attemptStats, attempts, notes: notes.filter((note) => ids.has(note.questionId)), roundProgress: roundProgress.filter((row) => ids.has(row.questionId)) };
  }, [bankKey]);

  const tags = useMemo(() => [...new Set((data?.questions ?? []).flatMap((question) => question.tags))].sort((a, b) => a.localeCompare(b, "zh-CN")), [data?.questions]);
  const normalizedScope = normalizeProgressScope(progressScope);
  const scopeLabel = scopeLabelFor(normalizedScope);
  const [referenceTime] = useState(Date.now);
  // Scoped per-question stats drive the displayed totals/difficulty so the
  // search surface matches the user's progress window; lifetime aggregates
  // remain available for the wrong-review status and the "last attempt" date.
  const scopedStatsByQuestion = useMemo(() => buildScopedQuestionStats((data?.questions ?? []).map((question) => question.id), normalizedScope, data?.attempts ?? [], data?.roundProgress ?? [], referenceTime), [data, normalizedScope, referenceTime]);
  const scopedMetricByQuestion = useMemo(() => new Map([...scopedStatsByQuestion.values()].map((stats) => [stats.questionId, summarizeAttemptStats(scopedStatsToLegacyAttemptStats(stats))])), [scopedStatsByQuestion]);
  const result = useMemo(() => {
    const questions = data?.questions ?? [];
    const attemptStats = data?.attemptStats ?? [];
    const notes = data?.notes ?? [];
    const roundProgress = data?.roundProgress ?? [];
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    let pattern: RegExp | null = null;
    if (normalized && keywordMode === "regex") {
      try { pattern = new RegExp(query.trim(), "i"); } catch { return { entries: [], counts: { 单选: 0, 多选: 0, 判断: 0, 计算: 0 }, error: "正则表达式格式不正确" }; }
    }
    const notesByQuestion = new Map(notes.map((note) => [note.questionId, note.content]));
    const statsByQuestion = new Map(attemptStats.map((stats) => [stats.questionId, stats]));
    const minDifficulty = numberOrNull(difficultyMin);
    const maxDifficulty = numberOrNull(difficultyMax);
    const minAttempts = numberOrNull(attemptsMin);
    const maxAttempts = numberOrNull(attemptsMax);
    const minWrong = numberOrNull(wrongMin);
    const maxWrong = numberOrNull(wrongMax);
    const fromTime = lastFrom ? new Date(`${lastFrom}T00:00:00`).getTime() : null;
    const toTime = lastTo ? new Date(`${lastTo}T23:59:59.999`).getTime() : null;
    const base = questions.flatMap((question) => {
      const stats = statsByQuestion.get(question.id);
      const metric = scopedMetricByQuestion.get(question.id) ?? summarizeAttemptStats(stats);
      const latest = summarizeAttemptStats(stats).latest;
      const note = notesByQuestion.get(question.id) ?? "";
      const searchable = [question.stem, ...question.options, ...question.tags, note].join("\n");
      // An empty keyword is allowed: search by conditions only.
      const keywordMatches = !normalized || (pattern ? pattern.test(searchable) : searchable.toLocaleLowerCase("zh-CN").includes(normalized));
      if (!keywordMatches) return [];
      if (tag !== "all" && !question.tags.includes(tag)) return [];
      if (status === "unanswered" && isQuestionDoneInScope(question.id, normalizedScope, attemptStats, roundProgress, referenceTime)) return [];
      if (status === "wrong" && !statsNeedWrongReview(stats, wrongRemovalStreak)) return [];
      if (status === "favorite" && !question.favorite) return [];
      if (noteFilter === "with" && !note.trim()) return [];
      if (noteFilter === "without" && note.trim()) return [];
      if (minDifficulty !== null && metric.difficulty < minDifficulty) return [];
      if (maxDifficulty !== null && metric.difficulty > maxDifficulty) return [];
      if (minAttempts !== null && metric.total < minAttempts) return [];
      if (maxAttempts !== null && metric.total > maxAttempts) return [];
      if (minWrong !== null && metric.wrong < minWrong) return [];
      if (maxWrong !== null && metric.wrong > maxWrong) return [];
      if ((fromTime !== null || toTime !== null) && latest === null) return [];
      if (fromTime !== null && latest !== null && latest < fromTime) return [];
      if (toTime !== null && latest !== null && latest > toTime) return [];
      return [{ question, metric, hasNote: Boolean(note.trim()) }];
    });
    const counts = {
      单选: base.filter((entry) => entry.question.type === "单选").length,
      多选: base.filter((entry) => entry.question.type === "多选").length,
      判断: base.filter((entry) => entry.question.type === "判断").length,
      计算: base.filter((entry) => entry.question.type === "计算").length,
    };
    const filtered = typeTab === "全部" ? base : base.filter((entry) => entry.question.type === typeTab);
    return { entries: TYPE_ORDER.flatMap((type) => filtered.filter((entry) => entry.question.type === type)), counts, error: "" };
  }, [data, query, keywordMode, tag, status, noteFilter, difficultyMin, difficultyMax, attemptsMin, attemptsMax, wrongMin, wrongMax, lastFrom, lastTo, typeTab, wrongRemovalStreak, normalizedScope, referenceTime, scopedMetricByQuestion]);

  const visibleEntries = result.entries.slice(0, visibleCount);
  const selectedQuestions = result.entries.filter((entry) => selectedIds.includes(entry.question.id)).map((entry) => entry.question);
  const allSelected = result.entries.length > 0 && result.entries.every((entry) => selectedIds.includes(entry.question.id));

  async function favoriteSelected() {
    const targets = selectedQuestions.filter((question) => !question.favorite);
    await Promise.all(targets.map((question) => updateQuestionV6(question.id, { favorite: true })));
    onNotice(`已收藏 ${targets.length} 道题`);
  }

  async function addTagToSelected() {
    const nextTag = batchTag.trim();
    if (!nextTag) return;
    await Promise.all(selectedQuestions.map((question) => updateQuestionV6(question.id, { tags: [...new Set([...question.tags, nextTag])] })));
    setBatchTag("");
    onNotice(`已给 ${selectedQuestions.length} 道题添加标签“${nextTag}”`);
  }

  function clearHistory() {
    setHistory([]);
    localStorage.removeItem("study-search-history");
  }

  const showResults = query.trim() !== "" || searchTriggered;
  const totalCount = result.counts.单选 + result.counts.多选 + result.counts.判断 + result.counts.计算;

  return <div className="search-page">
    <div className="search-page-heading"><div><p className="eyebrow">查题、筛选与整理</p><h1>搜索题库</h1><p>{showResults ? result.error || `${query.trim() ? `“${query.trim()}”` : "条件搜索"}找到 ${totalCount} 道题` : "默认使用正则表达式，可组合题库、作答情况、标签、难度和日期筛选；不输入关键词也可按条件搜索。"}</p></div><div className="search-heading-actions"><label htmlFor="search-scope-select">搜索范围<AppSelect id="search-scope-select" ariaLabel="搜索范围" value={scope} onValueChange={(value) => { setScope(value as "current" | "all"); setBankId("all"); }} options={[{ value: "current", label: "首页已选题库" }, { value: "all", label: "全部题库" }]} /></label><label htmlFor="search-bank-select">指定题库<AppSelect id="search-bank-select" ariaLabel="指定题库" value={bankId} onValueChange={setBankId} options={[{ value: "all", label: "不指定" }, ...banks.filter((bank) => scope === "all" || currentBankIds.includes(bank.id)).map((bank) => ({ value: bank.id, label: bank.displayName || bank.name }))]} /></label></div></div>
    <section className="search-home-query"><Search size={20} /><input aria-label="搜索题库" value={query} onChange={(event) => { onQueryChange(event.target.value); setVisibleCount(50); }} onKeyDown={(event) => { if (event.key === "Enter") { setSearchTriggered(true); setVisibleCount(50); } }} placeholder="正则示例：弧垂|导线，普通文字也可直接输入" /><button className="search-trigger-button" onClick={() => { setSearchTriggered(true); setVisibleCount(50); }}><Search size={16} />搜索</button><button className={`search-filter-toggle ${advancedOpen ? "active" : ""}`} onClick={() => setAdvancedOpen(!advancedOpen)}><Filter size={16} />高级条件</button></section>
    {showResults && <section className="search-toolbar"><div className="search-type-tabs">{(["全部", ...TYPE_ORDER] as TypeTab[]).map((type) => <button key={type} className={typeTab === type ? "active" : ""} onClick={() => { setTypeTab(type); setVisibleCount(50); }}>{type}<span>{type === "全部" ? totalCount : result.counts[type]}</span></button>)}</div><small className="search-scope-note">未做按{scopeLabel}；作答、正确率与难度按{scopeLabel}统计，错题为终身口径。</small></section>}
    {advancedOpen && <section className="search-filter-panel"><label htmlFor="search-keyword-mode-select">关键词方式<AppSelect id="search-keyword-mode-select" ariaLabel="关键词方式" value={keywordMode} onValueChange={(value) => setKeywordMode(value as "plain" | "regex")} options={[{ value: "plain", label: "包含关键词" }, { value: "regex", label: "正则表达式" }]} /></label><label htmlFor="search-status-select">作答状态<AppSelect id="search-status-select" ariaLabel="作答状态" value={status} onValueChange={(value) => setStatus(value as SearchStatus)} options={[{ value: "all", label: "全部" }, { value: "unanswered", label: `进度口径未做（${normalizedScope.type === "rolling" ? `近 ${normalizedScope.days} 天` : normalizedScope.type === "lifetime" ? "全部时间" : "当前轮次"}）` }, { value: "wrong", label: "当前错题（终身统计）" }, { value: "favorite", label: "已收藏" }]} /></label><label htmlFor="search-tag-select">用户标签<AppSelect id="search-tag-select" ariaLabel="用户标签" value={tag} onValueChange={setTag} options={[{ value: "all", label: "全部标签" }, ...tags.map((item) => ({ value: item, label: item }))]} /></label><label htmlFor="search-note-select">个人解析<AppSelect id="search-note-select" ariaLabel="个人解析" value={noteFilter} onValueChange={(value) => setNoteFilter(value as NoteFilter)} options={[{ value: "all", label: "不限" }, { value: "with", label: "已有解析" }, { value: "without", label: "没有解析" }]} /></label><label>最低难度<input type="number" min="0" max="100" value={difficultyMin} onChange={(event) => setDifficultyMin(event.target.value)} placeholder="不限" /></label><label>最高难度<input type="number" min="0" max="100" value={difficultyMax} onChange={(event) => setDifficultyMax(event.target.value)} placeholder="不限" /></label><label>总作答最少<input type="number" min="0" value={attemptsMin} onChange={(event) => setAttemptsMin(event.target.value)} placeholder="不限" /></label><label>总作答最多<input type="number" min="0" value={attemptsMax} onChange={(event) => setAttemptsMax(event.target.value)} placeholder="不限" /></label><label>错误次数最少<input type="number" min="0" value={wrongMin} onChange={(event) => setWrongMin(event.target.value)} placeholder="不限" /></label><label>错误次数最多<input type="number" min="0" value={wrongMax} onChange={(event) => setWrongMax(event.target.value)} placeholder="不限" /></label><label>最后作答开始<input type="date" value={lastFrom} onInput={(event) => setLastFrom(event.currentTarget.value)} /></label><label>最后作答结束<input type="date" value={lastTo} onInput={(event) => setLastTo(event.currentTarget.value)} /></label></section>}
    {advancedOpen && (lastFrom || lastTo) && <button className="clear-search-dates" onClick={() => { setLastFrom(""); setLastTo(""); }}><X size={14} />清除作答日期</button>}
    {!showResults ? <section className="search-empty-page"><Search size={28} /><h2>输入关键词或按条件搜索</h2><p>支持普通关键词和正则表达式；也可以不输入关键词，设置条件后点击"搜索"。搜索只读取本地题库。</p>{history.length > 0 && <div className="search-history"><header><span><History size={15} />最近搜索</span><button onClick={clearHistory}>清除</button></header><div>{history.map((item) => <button key={item} onClick={() => onQueryChange(item)}>{item}</button>)}</div></div>}</section> : data === undefined ? <div className="search-loading"><LoaderCircle className="spin" />正在读取本地题库…</div> : result.error ? <div className="search-no-result"><CircleAlert /><h2>{result.error}</h2></div> : result.entries.length ? <>
      <section className="search-batch-bar"><label><input type="checkbox" checked={allSelected} onChange={() => setSelectedIds(allSelected ? [] : result.entries.map((entry) => entry.question.id))} />选择当前 {result.entries.length} 道结果</label><span>已选择 {selectedQuestions.length} 道</span><div><button disabled={!selectedQuestions.length} onClick={() => void favoriteSelected()}><Star size={15} />收藏所选</button><span className="batch-tag"><input value={batchTag} onChange={(event) => setBatchTag(event.target.value)} placeholder="批量添加标签" /><button disabled={!selectedQuestions.length || !batchTag.trim()} onClick={() => void addTagToSelected()}><Tags size={15} />添加</button></span><button disabled={!selectedQuestions.length} onClick={() => onGroup(selectedQuestions.map((question) => question.id))}><GitBranch size={15} />加入题组</button><button disabled={!selectedQuestions.length} onClick={() => setPracticeSource({ questions: selectedQuestions, label: `搜索已选 ${selectedQuestions.length} 题` })}><ListChecks size={15} />练习已选</button><button className="primary" onClick={() => setPracticeSource({ questions: result.entries.map((entry) => entry.question), label: `搜索“${query.trim() || "条件"}”` })}><Play size={15} />练习全部结果</button></div></section>
      <div className="search-result-list">{visibleEntries.map(({ question, metric, hasNote }, index) => <article key={question.id} className={selectedIds.includes(question.id) ? "selected" : ""}><label className="result-checkbox"><input type="checkbox" checked={selectedIds.includes(question.id)} onChange={() => setSelectedIds(selectedIds.includes(question.id) ? selectedIds.filter((id) => id !== question.id) : [...selectedIds, question.id])} /><span>{index + 1}</span></label><button className="search-result-main" onClick={() => setDetailQuestionId(question.id)}><div><span className="result-type">{question.type}</span><span>{question.bankName}</span>{question.tags.map((item) => <em key={item}>{item}</em>)}</div><h2><MathText text={question.stem} /></h2><p>难度 {metric.difficulty} · 作答 {metric.total} 次 · 错误 {metric.wrong} 次（{scopeLabel}）{hasNote ? " · 已有个人解析" : ""}</p></button><ChevronRight size={18} /></article>)}</div>
      {visibleCount < result.entries.length && <button className="search-load-more" onClick={() => setVisibleCount(visibleCount + 50)}>继续加载（已显示 {visibleEntries.length} / {result.entries.length}）</button>}
    </> : <div className="search-no-result"><Search /><h2>没有符合条件的题目</h2><p>可以缩短关键词或减少筛选条件。</p></div>}
    {detailQuestionId && <SearchQuestionDetail questionId={detailQuestionId} metric={scopedMetricByQuestion.get(detailQuestionId) ?? summarizeAttemptStats()} scopeLabel={scopeLabel} onClose={() => { setDetailQuestionId(undefined); onFocusHandled(); }} onStart={(question) => setPracticeSource({ questions: [question], label: "单题练习" })} onGroup={(questionId) => onGroup([questionId])} onNotice={onNotice} />}
    {practiceSource && <SearchPracticeDialog source={practiceSource} defaultShuffleOptions={defaultShuffleOptions} onClose={() => setPracticeSource(undefined)} onStart={async (options) => { await onStart(options); setPracticeSource(undefined); }} />}
  </div>;
}

function SearchQuestionDetail({ questionId, metric, scopeLabel, onClose, onStart, onGroup, onNotice }: { questionId: string; metric: AttemptSummary; scopeLabel: string; onClose: () => void; onStart: (question: Question) => void; onGroup: (questionId: string) => void; onNotice: (message: string) => void }) {
  const view = useLiveQuery(() => getQuestionViewV6(questionId), [questionId]);
  const question = view ? toQuestionViewModel(view.question, view.sourceBankId, view.banks[0]?.displayName || view.banks[0]?.name || "未归档题目", view.memberships[0]?.sortOrder ?? 0) : undefined;
  const note = useLiveQuery(() => dbV6.notes.get(questionId), [questionId]);
  const [editing, setEditing] = useState(false);
  if (!question) return null;
  return <><QuestionDetail question={question} metric={metric} scopeLabel={scopeLabel} note={note?.content} onClose={onClose} footer={<><button onClick={async () => { const updated = await updateQuestionV6(question.id, { favorite: !question.favorite }); onNotice(updated.favorite ? "已收藏这道题" : "已取消收藏"); }}><Star size={16} fill={question.favorite ? "currentColor" : "none"} />{question.favorite ? "已收藏" : "收藏"}</button><button onClick={() => setEditing(true)}><Pencil size={16} />编辑题目</button><button onClick={() => onGroup(question.id)}><GitBranch size={16} />加入题组</button><button className="primary" onClick={() => onStart(question)}><Play size={16} />只练这一题</button></>} />{editing && <SharedQuestionEditor question={question.canonical} preferredBankId={question.bankId} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); onNotice("题目和标签已保存"); }} />}</>;
}

function SearchPracticeDialog({ source, defaultShuffleOptions, onClose, onStart }: { source: { questions: Question[]; label: string }; defaultShuffleOptions: boolean; onClose: () => void; onStart: (options: SearchPracticeOptions) => Promise<void> }) {
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
    try { await onStart({ questions: ordered, label: source.label, shuffleOptions }); }
    finally { setStarting(false); }
  }
  return <ModalPortal><div className="search-practice-backdrop" role="presentation"><section className="search-practice-dialog" role="dialog" aria-modal="true" aria-label="搜索练习配置"><header><div><span className="section-kicker">确认后才进入练习</span><h2>配置搜索练习</h2></div><button className="icon-button" aria-label="关闭练习配置" onClick={onClose}><X size={18} /></button></header><div><p>共有 <strong>{source.questions.length}</strong> 道可练题目，题型始终按“单选 → 多选 → 判断 → 计算”排列。</p><label>练习数量<input type="number" min="1" max={source.questions.length} value={count} onChange={(event) => setCount(event.target.value)} placeholder={`全部 ${source.questions.length} 题`} /></label><label htmlFor="search-practice-order-select">题型组内顺序<AppSelect id="search-practice-order-select" ariaLabel="题型组内顺序" value={order} onValueChange={(value) => setOrder(value as "sequential" | "random")} options={[{ value: "sequential", label: "当前结果顺序" }, { value: "random", label: "组内随机" }]} /></label><label className="search-dialog-toggle"><span><strong>选项顺序随机</strong><small>判断题与计算题不受影响</small></span><input aria-label="选项顺序随机" type="checkbox" checked={shuffleOptions} onChange={(event) => setShuffleOptions(event.target.checked)} /></label></div><footer><button className="secondary-action" onClick={onClose}>取消</button><button className="primary" disabled={starting || !finalCount} onClick={() => void start()}>{starting ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}开始练习 {finalCount} 题</button></footer></section></div></ModalPortal>;
}
