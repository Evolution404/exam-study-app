"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ChevronRight, CircleAlert, Filter, GitBranch, History, ListChecks, LoaderCircle,
  Pencil, Play, Search, Star, Tags, X,
} from "lucide-react";
import { SharedQuestionEditor, toQuestionViewModel, type QuestionViewModel } from "@/app/bank/question-editor";
import { MathText } from "@/app/ui/math-text";
import { QuestionDetail } from "@/app/bank/question-detail";
import { dbV7, updateQuestionV7 } from "@/lib/db/db-v7";
import { getQuestionViewV7, listQuestionViewsForBanksV7, type QuestionViewV7 } from "@/lib/db/app-data-v7";
import { ModalPortal } from "@/app/ui/modal-portal";
import { AppSelect } from "@/app/ui/app-select";
import {
  SearchFilterDrawer,
  countActiveSearchFilters,
  createDefaultSearchFilters,
  effectiveSearchProgressScope,
  resolveSearchBankIds,
  type SearchFilters,
} from "@/app/search/search-filter-drawer";
import { statsNeedWrongReview, summarizeAttemptStats, type AttemptSummary } from "@/lib/practice/practice-metrics";
import { buildScopedQuestionStats, isQuestionDoneInScope, scopedStatsToAttemptStats, type ProgressScope } from "@/lib/practice/progress-scope";
import { DEFAULT_KEYBOARD_SHORTCUTS, normalizeKeyboardShortcuts } from "@/lib/practice/keyboard-shortcuts";
import type { BankV7, QuestionTypeV7 } from "@/lib/db/v7-types";
import { createSearchMatcher, SEARCH_CONTENT_SCOPE_OPTIONS, SEARCH_TYPE_ORDER, type SearchContentScope, type SearchFilterProjection, type SearchIndexQuestion, type SearchIndexResult } from "@/app/search/search-matching";
import { useSearchWorkerClient } from "@/app/search/search-worker-client";
import { emptyTypeCounts, searchIndexFingerprint } from "@/lib/question/search-matching";
import { buildSearchIndexQuestion } from "@/lib/question/search-read-model";
type Bank = BankV7;
type Question = QuestionViewModel;
type QuestionType = QuestionTypeV7;

const TYPE_ORDER: QuestionType[] = [...SEARCH_TYPE_ORDER];
type TypeTab = "全部" | QuestionType;

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

function searchFilterValidationError(filters: SearchFilters) {
  const ranges = [
    [filters.difficultyMin, filters.difficultyMax, "个人难度"],
    [filters.attemptsMin, filters.attemptsMax, "总作答次数"],
    [filters.wrongMin, filters.wrongMax, "错误次数"],
  ] as const;
  for (const [minimum, maximum, label] of ranges) {
    if (minimum && maximum && Number(minimum) > Number(maximum)) return `${label}范围不正确`;
  }
  if (filters.lastFrom && filters.lastTo && filters.lastFrom > filters.lastTo) return "作答日期范围不正确";
  return "";
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

function questionsForFilters(views: readonly QuestionViewV7[], banks: readonly Bank[], bankIds: readonly string[]): Question[] {
  const selected = new Set(bankIds);
  const bankMap = new Map(banks.map((bank) => [bank.id, bank]));
  return views.flatMap((view) => {
    const membership = view.memberships.find((item) => selected.has(item.bankId));
    if (!membership) return [];
    const bank = bankMap.get(membership.bankId);
    return [toQuestionViewModel(view.question, membership.bankId, bank?.displayName || bank?.name || "未归档题目", membership.sortOrder)];
  });
}

function timestampOrNull(value: string, endOfDay = false) {
  if (!value) return null;
  const timestamp = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00"}`).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function toSearchFilterProjection(filters: SearchFilters): SearchFilterProjection {
  return {
    keywordMode: filters.keywordMode,
    contentScope: filters.contentScope,
    status: filters.status,
    tags: filters.tags,
    tagMatch: filters.tagMatch,
    noteFilter: filters.noteFilter,
    difficultyMin: numberOrNull(filters.difficultyMin),
    difficultyMax: numberOrNull(filters.difficultyMax),
    attemptsMin: numberOrNull(filters.attemptsMin),
    attemptsMax: numberOrNull(filters.attemptsMax),
    wrongMin: numberOrNull(filters.wrongMin),
    wrongMax: numberOrNull(filters.wrongMax),
    lastFrom: timestampOrNull(filters.lastFrom),
    lastTo: timestampOrNull(filters.lastTo, true),
  };
}

export function SearchView({
  query,
  onQueryChange,
  banks,
  currentBankIds,
  initialContentScope = "all",
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
  initialContentScope?: SearchContentScope;
  focusQuestionId?: string;
  onFocusHandled: () => void;
  wrongRemovalStreak: number;
  progressScope?: ProgressScope;
  defaultShuffleOptions: boolean;
  onStart: (options: SearchPracticeOptions) => Promise<void>;
  onGroup: (questionIds: string[]) => void;
  onNotice: (message: string) => void;
}) {
  const [filters, setFilters] = useState<SearchFilters>(() => createDefaultSearchFilters(currentBankIds, initialContentScope));
  const pageRef = useRef<HTMLDivElement>(null);
  const searchClientRef = useSearchWorkerClient();

  // 吸附两阶段状态（JS 给 .search-page 加状态类，CSS 过渡接管视觉）：
  // search-pinned：搜索框吸到视口顶部 → 上圆角压平贴顶（下边缘保持圆角）。
  // search-stuck：批量栏贴上搜索框 → 去掉批量栏上圆角，与搜索框无缝相接。
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const query = page.querySelector<HTMLElement>(".search-home-query");
    if (!query) return;
    const workspace = document.querySelector(".workspace");
    const scroller: Window | Element = workspace && getComputedStyle(workspace).overflowY === "auto" ? workspace : window;
    let frame = 0;
    const update = () => {
      frame = 0;
      const bar = page.querySelector<HTMLElement>(".search-batch-bar");
      const queryRect = query.getBoundingClientRect();
      page.style.setProperty("--search-query-sticky-height", `${queryRect.height}px`);
      if (!bar) { page.classList.remove("search-stuck", "search-pinned"); return; }
      page.classList.toggle("search-pinned", queryRect.top <= 1);
      page.classList.toggle("search-stuck", bar.getBoundingClientRect().top <= queryRect.bottom + 1);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const queryResizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    queryResizeObserver?.observe(query);
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    update();
    return () => {
      queryResizeObserver?.disconnect();
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
      page.style.removeProperty("--search-query-sticky-height");
    };
  }, []);

  const [typeTab, setTypeTab] = useState<TypeTab>("全部");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [searchTriggered, setSearchTriggered] = useState(false);
  const [visibleCount, setVisibleCount] = useState(50);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [detailQuestionId, setDetailQuestionId] = useState<string | undefined>(focusQuestionId);
  const [activeQuestionId, setActiveQuestionId] = useState<string | undefined>(focusQuestionId);
  const [practiceSource, setPracticeSource] = useState<{ questions: Question[]; label: string }>();

  useEffect(() => {
    if (!detailQuestionId) return;
    document.querySelector(`.search-result-list article[data-question-id="${detailQuestionId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [detailQuestionId]);
  const [batchTag, setBatchTag] = useState("");
  const [history, setHistory] = useState(loadSearchHistory);
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 160);
    return () => window.clearTimeout(timer);
  }, [query]);

  const allBankIds = banks.map((bank) => bank.id);
  const bankKey = allBankIds.join("|");
  const data = useLiveQuery(async () => {
    const views = await listQuestionViewsForBanksV7(allBankIds);
    const ids = new Set(views.map((view) => view.question.id));
    const sourceBankByQuestion = new Map(views.map((view) => [view.question.id, view.memberships[0]?.bankId ?? ""]));
    const [rawStats, rawAttempts, notes, roundProgress] = await Promise.all([dbV7.attemptStats.toArray(), dbV7.attempts.toArray(), dbV7.notes.toArray(), dbV7.reviewRoundProgress.toArray()]);
    const attemptStats = rawStats.filter((stats) => ids.has(stats.questionId)).map((stats) => ({ ...stats, bankId: sourceBankByQuestion.get(stats.questionId) ?? "" }));
    const attempts = rawAttempts.filter((attempt) => ids.has(attempt.questionId));
    return { views, attemptStats, attempts, notes: notes.filter((note) => ids.has(note.questionId)), roundProgress: roundProgress.filter((row) => ids.has(row.questionId)) };
  }, [bankKey]);

  const appliedBankIds = useMemo(() => resolveSearchBankIds(filters, banks, currentBankIds), [banks, currentBankIds, filters]);
  const appliedQuestions = useMemo(() => questionsForFilters(data?.views ?? [], banks, appliedBankIds), [appliedBankIds, banks, data?.views]);
  const tags = useMemo(() => [...new Set(appliedQuestions.flatMap((question) => question.tags))].sort((a, b) => a.localeCompare(b, "zh-CN")), [appliedQuestions]);
  const [referenceTime] = useState(Date.now);
  const normalizedSearchScope = useMemo(() => effectiveSearchProgressScope(filters, progressScope), [filters, progressScope]);
  const derivedSearchData = useMemo(() => {
    const normalizedScope = normalizedSearchScope;
    const questions = appliedQuestions;
    const scopedStatsByQuestion = buildScopedQuestionStats(questions.map((question) => question.id), normalizedScope, data?.attempts ?? [], data?.roundProgress ?? [], referenceTime);
    const scopedMetricByQuestion = new Map([...scopedStatsByQuestion.values()].map((stats) => [stats.questionId, summarizeAttemptStats(scopedStatsToAttemptStats(stats))]));
    const attemptStats = data?.attemptStats ?? [];
    const statsByQuestion = new Map(attemptStats.map((stats) => [stats.questionId, stats]));
    const notesByQuestion = new Map((data?.notes ?? []).map((note) => [note.questionId, note.content]));
    const scopedLegacyByQuestion = new Map([...scopedStatsByQuestion.values()].map((stats) => [stats.questionId, scopedStatsToAttemptStats(stats)]));
    const index: SearchIndexQuestion[] = questions.map((question) => {
      const stats = statsByQuestion.get(question.id);
      const metric = scopedMetricByQuestion.get(question.id) ?? summarizeAttemptStats(stats);
      const latest = summarizeAttemptStats(stats).latest;
      const note = notesByQuestion.get(question.id) ?? "";
      return buildSearchIndexQuestion(question.canonical, {
        explanation: note,
        difficulty: metric.difficulty,
        total: metric.total,
        wrong: metric.wrong,
        latest,
        done: isQuestionDoneInScope(question.id, normalizedScope, attemptStats, data?.roundProgress ?? [], referenceTime),
        needsWrongReview: statsNeedWrongReview(scopedLegacyByQuestion.get(question.id), wrongRemovalStreak),
      });
    });
    return { index, scopedMetricByQuestion, normalizedScope, indexById: new Map(index.map((item) => [item.id, item])) };
  }, [appliedQuestions, data, normalizedSearchScope, referenceTime, wrongRemovalStreak]);
  const filterProjection = useMemo(() => toSearchFilterProjection(filters), [filters]);
  const searchIndexKey = useMemo(() => `${appliedBankIds.join("|")}:${searchIndexFingerprint(derivedSearchData.index)}`, [appliedBankIds, derivedSearchData.index]);
  const showResults = query.trim() !== "" || searchTriggered;
  const searchRequestKey = useMemo(() => `${searchIndexKey}:${debouncedQuery}:${JSON.stringify(filterProjection)}:${typeTab}`, [debouncedQuery, filterProjection, searchIndexKey, typeTab]);
  const [completedSearch, setCompletedSearch] = useState<{ key: string; result: SearchIndexResult }>();

  useEffect(() => {
    const searchWorkerClient = searchClientRef.current;
    if (!showResults || !searchWorkerClient) {
      searchWorkerClient?.cancel();
      return;
    }
    let active = true;
    void searchWorkerClient.search({
      indexKey: searchIndexKey,
      index: derivedSearchData.index,
      request: { query: debouncedQuery, filters: filterProjection, typeTab },
    }).then((next) => {
      if (!active || !next) return;
      setCompletedSearch({ key: searchRequestKey, result: next });
    });
    return () => {
      active = false;
      searchWorkerClient.cancel();
    };
  }, [debouncedQuery, derivedSearchData.index, filterProjection, searchClientRef, searchIndexKey, searchRequestKey, searchTriggered, showResults, typeTab]);

  const searchPending = showResults && completedSearch?.key !== searchRequestKey;
  const result = completedSearch?.key === searchRequestKey
    ? completedSearch.result
    : { ids: [], total: 0, counts: emptyTypeCounts(), error: "" };
  const questionById = useMemo(() => new Map(appliedQuestions.map((question) => [question.id, question])), [appliedQuestions]);
  const resultEntries = result.ids.flatMap((id) => {
    const question = questionById.get(id);
    if (!question) return [];
    const indexQuestion = derivedSearchData.indexById.get(id);
    const metric = derivedSearchData.scopedMetricByQuestion.get(id) ?? summarizeAttemptStats();
    return [{ question, metric, hasNote: Boolean(indexQuestion?.explanation.trim()) }];
  });
  const scopedMetricByQuestion = derivedSearchData.scopedMetricByQuestion;
  const scopeLabel = scopeLabelFor(derivedSearchData.normalizedScope);

  const visibleEntries = resultEntries.slice(0, visibleCount);
  const selectedQuestions = resultEntries.filter((entry) => selectedIds.includes(entry.question.id)).map((entry) => entry.question);
  const allSelected = resultEntries.length > 0 && resultEntries.every((entry) => selectedIds.includes(entry.question.id));

  async function favoriteSelected() {
    const targets = selectedQuestions.filter((question) => !question.favorite);
    await Promise.all(targets.map((question) => updateQuestionV7(question.id, { favorite: true })));
    onNotice(`已收藏 ${targets.length} 道题`);
  }

  async function addTagToSelected() {
    const nextTag = batchTag.trim();
    if (!nextTag) return;
    await Promise.all(selectedQuestions.map((question) => updateQuestionV7(question.id, { tags: [...new Set([...question.tags, nextTag])] })));
    setBatchTag("");
    onNotice(`已给 ${selectedQuestions.length} 道题添加标签“${nextTag}”`);
  }

  function clearHistory() {
    setHistory([]);
    localStorage.removeItem("study-search-history");
  }

  function triggerSearch() {
    const validationError = searchFilterValidationError(filters) || createSearchMatcher(query, filters.keywordMode).error || result.error;
    if (validationError) {
      onNotice(validationError);
      return;
    }
    // Enter/click is an explicit search action, so bypass the typing debounce
    // and make the just-submitted query visible in the same render cycle.
    setDebouncedQuery(query);
    if (filters.bankScope === "custom" && !filters.customBankIds.length) {
      onNotice("请至少选择一个指定题库");
      return;
    }
    setSearchTriggered(true);
    setVisibleCount(50);
    setSelectedIds([]);
    const term = query.trim();
    if (!term) return;
    const nextHistory = [term, ...history.filter((item) => item !== term)].slice(0, 10);
    setHistory(nextHistory);
    localStorage.setItem("study-search-history", JSON.stringify(nextHistory));
  }

  function openFilters() {
    setAdvancedOpen(true);
  }

  function updateFilters(nextFilters: SearchFilters) {
    setFilters(nextFilters);
    setVisibleCount(50);
    setSelectedIds([]);
  }

  const totalCount = result.counts.单选 + result.counts.多选 + result.counts.判断 + result.counts.计算;
  const activeFilterCount = countActiveSearchFilters(filters);
  const filterChips = [
    filters.bankScope === "current" ? "已选题库" : filters.bankScope === "all" ? "全部题库" : `指定题库 · ${filters.customBankIds.length} 个`,
    filters.status === "unanswered" ? "未做" : filters.status === "wrong" ? "错题" : filters.status === "favorite" ? "收藏" : "",
    filters.keywordMode === "regex" ? "正则表达式" : "",
    filters.contentScope !== "all" ? `范围：${SEARCH_CONTENT_SCOPE_OPTIONS.find((option) => option.value === filters.contentScope)?.label ?? "全部"}` : "",
    filters.tags.length ? `标签${filters.tagMatch === "all" ? "（全部）" : "（任一）"}：${filters.tags.join("、")}` : "",
    filters.noteFilter === "with" ? "已有解析" : filters.noteFilter === "without" ? "没有解析" : "",
    filters.progressScopeOverride ? `统计：${scopeLabelFor(filters.progressScopeOverride)}` : "",
  ].filter(Boolean);

  return <div className="search-page" ref={pageRef}>
    <div className="search-page-heading"><div><p className="eyebrow">查题、筛选与整理</p><h1>搜索题库</h1><p>{showResults ? result.error || `${query.trim() ? `“${query.trim()}”` : "条件搜索"}找到 ${totalCount} 道题` : "默认正则表达式，也可以组合题库、学习状态、标签、个人难度和日期进行筛选。"}</p></div></div>
    <section className="search-home-query"><Search size={20} /><input aria-label="搜索题库" value={query} onChange={(event) => { onQueryChange(event.target.value); setVisibleCount(50); }} onKeyDown={(event) => { if (event.key === "Enter") triggerSearch(); }} placeholder={filters.keywordMode === "regex" ? "正则示例：弧垂|导线" : "输入题干、答案、选项、解析"} /><AppSelect ariaLabel="搜索内容范围" className="search-content-scope" contentClassName="search-scope-select-content" value={filters.contentScope} onValueChange={(contentScope) => updateFilters({ ...filters, contentScope: contentScope as SearchContentScope })} options={SEARCH_CONTENT_SCOPE_OPTIONS} /><div className="search-query-actions"><button aria-label="搜索" className="search-trigger-button" onClick={triggerSearch}><Search size={16} /><span className="search-action-label">搜索</span></button><button aria-label={activeFilterCount ? `筛选，已设置 ${activeFilterCount} 项` : "筛选"} className={`search-filter-toggle ${activeFilterCount ? "active" : ""}`} onClick={openFilters}><Filter size={16} /><span className="search-action-label">筛选</span>{activeFilterCount > 0 && <span className="search-filter-count">{activeFilterCount}</span>}</button></div></section>
    <div className="search-filter-chips" aria-label="当前筛选条件">{filterChips.map((chip) => <span key={chip}>{chip}</span>)}</div>
    {showResults && <section className="search-toolbar"><div className="search-type-tabs">{(["全部", ...TYPE_ORDER] as TypeTab[]).map((type) => <button key={type} className={typeTab === type ? "active" : ""} onClick={() => { setTypeTab(type); setVisibleCount(50); }}>{type}<span>{type === "全部" ? totalCount : result.counts[type]}</span></button>)}</div></section>}
    {!showResults ? <section className="search-empty-page"><Search size={28} /><h2>输入关键词或按条件搜索</h2><p>支持正则表达式和普通关键词；也可以不输入关键词，设置条件后点击“搜索”。搜索只读取本地题库。</p>{history.length > 0 && <div className="search-history"><header><span><History size={15} />最近搜索</span><button onClick={clearHistory}>清除</button></header><div>{history.map((item) => <button key={item} onClick={() => onQueryChange(item)}>{item}</button>)}</div></div>}</section> : data === undefined ? <div className="search-loading"><LoaderCircle className="spin" />正在读取本地题库…</div> : searchPending ? <div className="search-loading"><LoaderCircle className="spin" />正在搜索…</div> : result.error ? <div className="search-no-result"><CircleAlert /><h2>{result.error}</h2></div> : resultEntries.length ? <>
      <section className="search-batch-bar"><label><input type="checkbox" checked={allSelected} onChange={() => setSelectedIds(allSelected ? [] : resultEntries.map((entry) => entry.question.id))} />选择当前 {resultEntries.length} 道结果</label><span>已选择 {selectedQuestions.length} 道</span><div><button disabled={!selectedQuestions.length} onClick={() => void favoriteSelected()}><Star size={15} />收藏所选</button><span className="batch-tag"><input value={batchTag} onChange={(event) => setBatchTag(event.target.value)} placeholder="输入标签" /><button disabled={!selectedQuestions.length || !batchTag.trim()} onClick={() => void addTagToSelected()}><Tags size={15} />添加</button></span><button disabled={!selectedQuestions.length} onClick={() => onGroup(selectedQuestions.map((question) => question.id))}><GitBranch size={15} />加入题组</button><button disabled={!selectedQuestions.length} onClick={() => setPracticeSource({ questions: selectedQuestions, label: `搜索已选 ${selectedQuestions.length} 题` })}><ListChecks size={15} />练习已选</button><button className="primary" onClick={() => setPracticeSource({ questions: resultEntries.map((entry) => entry.question), label: `搜索“${query.trim() || "条件"}”` })}><Play size={15} />练习全部结果</button></div></section>
      <div className="search-result-list">{visibleEntries.map(({ question, metric, hasNote }, index) => <article key={question.id} data-question-id={question.id} className={`${selectedIds.includes(question.id) ? "selected" : ""} ${(detailQuestionId ?? activeQuestionId) === question.id ? "detail-current" : ""}`}><label className="result-checkbox"><input type="checkbox" checked={selectedIds.includes(question.id)} onChange={() => setSelectedIds(selectedIds.includes(question.id) ? selectedIds.filter((id) => id !== question.id) : [...selectedIds, question.id])} /><span>{index + 1}</span></label><button className="search-result-main" onClick={() => { setActiveQuestionId(question.id); setDetailQuestionId(question.id); }}><div><span className="result-type">{question.type}</span><span>{question.bankName}</span>{question.tags.map((item) => <em key={item}>{item}</em>)}</div><h2><MathText text={question.stem} /></h2><p>个人难度 {metric.difficulty} · 作答 {metric.total} 次 · 错误 {metric.wrong} 次（{scopeLabel}）{hasNote ? " · 已有个人解析" : ""}</p></button><ChevronRight size={18} /></article>)}</div>
      {visibleCount < resultEntries.length && <button className="search-load-more" onClick={() => setVisibleCount(visibleCount + 50)}>继续加载（已显示 {visibleEntries.length} / {resultEntries.length}）</button>}
    </> : <div className="search-no-result"><Search /><h2>没有符合条件的题目</h2><p>可以缩短关键词或减少筛选条件。</p></div>}
    {detailQuestionId && <SearchQuestionDetail questionId={detailQuestionId} entries={resultEntries} metric={scopedMetricByQuestion.get(detailQuestionId) ?? summarizeAttemptStats()} scopeLabel={scopeLabel} onClose={() => { setActiveQuestionId(detailQuestionId); setDetailQuestionId(undefined); onFocusHandled(); }} onGroup={(questionId) => onGroup([questionId])} onNavigate={(id) => { setActiveQuestionId(id); setDetailQuestionId(id); }} onNotice={onNotice} />}
    {practiceSource && <SearchPracticeDialog source={practiceSource} defaultShuffleOptions={defaultShuffleOptions} onClose={() => setPracticeSource(undefined)} onStart={async (options) => { await onStart(options); setPracticeSource(undefined); }} />}
    {advancedOpen && <SearchFilterDrawer open filters={filters} settingsProgressScope={progressScope} banks={banks} currentBankIds={currentBankIds} tags={tags} onChange={updateFilters} onReset={() => updateFilters(createDefaultSearchFilters(currentBankIds))} onClose={() => setAdvancedOpen(false)} />}
  </div>;
}

function SearchQuestionDetail({ questionId, entries, metric, scopeLabel, onClose, onGroup, onNavigate, onNotice }: { questionId: string; entries: Array<{ question: Question }>; metric: AttemptSummary; scopeLabel: string; onClose: () => void; onGroup: (questionId: string) => void; onNavigate: (questionId: string) => void; onNotice: (message: string) => void }) {
  const view = useLiveQuery(() => getQuestionViewV7(questionId), [questionId]);
  const question = view ? toQuestionViewModel(view.question, view.sourceBankId, view.banks[0]?.displayName || view.banks[0]?.name || "未归档题目", view.memberships[0]?.sortOrder ?? 0) : undefined;
  const note = useLiveQuery(() => dbV7.notes.get(questionId), [questionId]);
  const [editing, setEditing] = useState(false);
  const navPrefs = useMemo(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("study-v7-preferences") ?? localStorage.getItem("study-v6-preferences") ?? "{}");
      return { keyboardShortcuts: normalizeKeyboardShortcuts(saved.keyboardShortcuts), swipeNavigation: saved.swipeNavigation !== false };
    } catch {
      return { keyboardShortcuts: DEFAULT_KEYBOARD_SHORTCUTS, swipeNavigation: true };
    }
  }, []);
  if (!question) return null;
  const index = entries.findIndex((entry) => entry.question.id === questionId);
  const nav = index >= 0 ? {
    index,
    total: entries.length,
    onPrevious: () => onNavigate(entries[index - 1].question.id),
    onNext: () => onNavigate(entries[index + 1].question.id),
    keyboardShortcuts: navPrefs.keyboardShortcuts,
    swipeNavigation: navPrefs.swipeNavigation,
    
  } : undefined;
  return <><QuestionDetail question={question} metric={metric} scopeLabel={scopeLabel} note={note?.content} onClose={onClose} footer={<><button onClick={async () => { const updated = await updateQuestionV7(question.id, { favorite: !question.favorite }); onNotice(updated.favorite ? "已收藏这道题" : "已取消收藏"); }}><Star size={16} fill={question.favorite ? "currentColor" : "none"} />{question.favorite ? "已收藏" : "收藏"}</button><button onClick={() => setEditing(true)}><Pencil size={16} />编辑题目</button><button onClick={() => onGroup(question.id)}><GitBranch size={16} />加入题组</button></>} nav={nav} />{editing && <SharedQuestionEditor question={question.canonical} preferredBankId={question.bankId} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); onNotice("题目和标签已保存"); }} />}</>;
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
  return <ModalPortal><div className="search-practice-backdrop" role="presentation"><section className="search-practice-dialog" role="dialog" aria-modal="true" aria-label="搜索练习配置"><header><div><span className="section-kicker">确认后才进入练习</span><h2>配置搜索练习</h2></div><button className="icon-button" aria-label="关闭练习配置" onClick={onClose}><X size={18} /></button></header><div><p>共有 <strong>{source.questions.length}</strong> 道可练题目，题型始终按“单选 → 多选 → 判断 → 计算”排列。</p><label>练习数量<input type="number" min="1" max={source.questions.length} value={count} onChange={(event) => setCount(event.target.value)} placeholder={`全部 ${source.questions.length} 题`} /></label><label htmlFor="search-practice-order-select">题型组内顺序<AppSelect id="search-practice-order-select" ariaLabel="题型组内顺序" value={order} onValueChange={(value) => setOrder(value as "sequential" | "random")} options={[{ value: "sequential", label: "当前结果顺序" }, { value: "random", label: "组内随机" }]} /></label><label className="search-dialog-toggle"><span><strong>选项顺序随机</strong><small>判断题与计算题不受影响</small></span><input aria-label="选项顺序随机" type="checkbox" checked={shuffleOptions} onChange={(event) => setShuffleOptions(event.target.checked)} /></label></div><footer><button className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={starting || !finalCount} onClick={() => void start()}>{starting ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}开始练习 {finalCount} 题</button></footer></section></div></ModalPortal>;
}
