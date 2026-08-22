"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronRight, LoaderCircle, Search, X } from "lucide-react";
import { MathText } from "@/app/ui/math-text";
import { Hint } from "@/app/ui/hint";
import { AppSelect } from "@/app/ui/app-select";
import { toQuestionViewModel } from "@/app/bank/question-editor";
import { dbV7 } from "@/lib/db/db-v7";
import { listQuestionViewsForBanksV7 } from "@/lib/db/app-data-v7";
import type { BankV7 } from "@/lib/db/v7-types";
import { SEARCH_CONTENT_SCOPE_OPTIONS, type SearchContentScope, type SearchIndexQuestion, type SearchIndexResult } from "@/app/search/search-matching";
import { createSearchWorkerClient } from "@/app/search/search-worker-client";
import { emptySearchFilterProjection, emptyTypeCounts, searchIndexFingerprint } from "@/lib/question/search-matching";

/**
 * Keep the topbar quick search on the input/update timing that originally
 * fixed the iOS caret regression: the input owns only this component's draft,
 * the IndexedDB subscription is keyed only by bank scope, and keystrokes do
 * not schedule a delayed result-state update.
 */
export function QuickSearch({ banks, activeBankIds, onOpenSearch }: {
  banks: BankV7[];
  activeBankIds: string[];
  onOpenSearch: (keyword: string, questionId?: string, contentScope?: SearchContentScope) => void;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [contentScope, setContentScope] = useState<SearchContentScope>("all");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && !boxRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  function openSearch(questionId?: string) {
    setOpen(false);
    if (contentScope === "all") onOpenSearch(draft.trim(), questionId);
    else onOpenSearch(draft.trim(), questionId, contentScope);
  }

  return <div ref={boxRef} className={`searchbox ${open && draft.trim() ? "results-open" : ""}`}>
    <Hint label="搜索主页与高级筛选"><button className="search-page-trigger" aria-label="进入搜索主页" onClick={() => openSearch()}><Search size={17} /></button></Hint>
    <input aria-label="快速正则搜索题目、选项、标签或解析" value={draft} onFocus={() => { setOpen(true); }} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setDraft(""); setOpen(false); } else if (event.key === "Enter") { event.currentTarget.blur(); openSearch(); } }} placeholder="快速搜索" />
    <AppSelect ariaLabel="快速搜索范围" className="quick-search-scope" contentClassName="search-scope-select-content quick-search-scope-content" value={contentScope} onValueChange={(value) => { setContentScope(value as SearchContentScope); setOpen(true); }} options={SEARCH_CONTENT_SCOPE_OPTIONS} />
    {draft && <button className="search-clear" aria-label="清除搜索" onClick={() => { setDraft(""); setOpen(false); }}><X size={15} /></button>}
    <QuickSearchResults query={draft} contentScope={contentScope} bankIds={activeBankIds.length ? activeBankIds : banks.map((bank) => bank.id)} onChoose={(questionId) => openSearch(questionId)} onViewAll={() => openSearch()} />
  </div>;
}

function QuickSearchResults({ query, contentScope, bankIds, onChoose, onViewAll }: { query: string; contentScope: SearchContentScope; bankIds: string[]; onChoose: (questionId: string) => void; onViewAll: () => void }) {
  const normalizedQuery = query.trim();
  const bankKey = bankIds.join("|");
  const searchWorkerClient = useMemo(() => createSearchWorkerClient(), []);

  useEffect(() => () => searchWorkerClient.dispose(), [searchWorkerClient]);

  // This is the key invariant from the original caret fix: load/map the bank
  // once per bank scope. Typing only filters the already-loaded in-memory data.
  const data = useLiveQuery(async () => {
    if (!bankIds.length) {
      return { questions: [] as ReturnType<typeof toQuestionViewModel>[], notes: new Map<string, string>() };
    }
    const [views, notes] = await Promise.all([
      listQuestionViewsForBanksV7(bankIds),
      dbV7.notes.toArray(),
    ]);
    const questions = views.map((view) => {
      const bank = view.banks.find((item) => item.id === view.sourceBankId) ?? view.banks[0];
      const membership = view.memberships.find((item) => item.bankId === view.sourceBankId) ?? view.memberships[0];
      return toQuestionViewModel(view.question, view.sourceBankId ?? "", bank?.displayName || bank?.name || "未归档题目", membership?.sortOrder ?? 0);
    });
    return { questions, notes: new Map(notes.map((note) => [note.questionId, note.content])) };
  }, [bankKey]);

  const index = useMemo<SearchIndexQuestion[]>(() => {
    const questions = data?.questions ?? [];
    const notesByQuestion = data?.notes ?? new Map<string, string>();
    return questions.map((question) => ({
      id: question.id,
      type: question.type,
      stem: question.stem,
      options: question.options,
      tags: question.tags,
      explanation: notesByQuestion.get(question.id) ?? "",
      favorite: Boolean(question.favorite),
      // Quick search has no learning-stat filters; neutral values keep the
      // shared pure matcher reusable without transferring stats or canonical
      // content into the worker.
      difficulty: 50,
      total: 0,
      wrong: 0,
      latest: null,
      done: false,
      needsWrongReview: false,
    }));
  }, [data]);
  const searchIndexKey = useMemo(() => `${bankKey}:${searchIndexFingerprint(index)}`, [bankKey, index]);
  const filterProjection = useMemo(() => emptySearchFilterProjection(contentScope), [contentScope]);
  const searchRequestKey = useMemo(() => `${searchIndexKey}:${normalizedQuery}:${contentScope}`, [contentScope, normalizedQuery, searchIndexKey]);
  const [completedSearch, setCompletedSearch] = useState<{ key: string; result: SearchIndexResult }>();

  useEffect(() => {
    if (!normalizedQuery || !bankIds.length || !data) {
      searchWorkerClient.cancel();
      return;
    }
    let active = true;
    void searchWorkerClient.search({
      indexKey: searchIndexKey,
      index,
      request: { query: normalizedQuery, filters: filterProjection, limit: 8 },
    }).then((next) => {
      if (!active || !next) return;
      setCompletedSearch({ key: searchRequestKey, result: next });
    });
    return () => {
      active = false;
      searchWorkerClient.cancel();
    };
  }, [bankIds.length, data, filterProjection, index, normalizedQuery, searchIndexKey, searchRequestKey, searchWorkerClient]);

  const questionsById = useMemo(() => new Map((data?.questions ?? []).map((question) => [question.id, question])), [data]);
  const searchPending = Boolean(normalizedQuery && data && completedSearch?.key !== searchRequestKey);
  const results = completedSearch?.key === searchRequestKey
    ? completedSearch.result
    : { ids: [], total: 0, counts: emptyTypeCounts(), error: "" };
  const items = results.ids.flatMap((id) => {
    const question = questionsById.get(id);
    return question ? [question] : [];
  });

  if (!normalizedQuery) return null;
  if (data === undefined) return <section className="search-results"><div className="search-state"><LoaderCircle className="spin" size={17} />正在搜索…</div></section>;
  if (searchPending) return <section className="search-results"><div className="search-state"><LoaderCircle className="spin" size={17} />正在搜索…</div></section>;
  return <section className="search-results" aria-label="搜索结果">
    <header><strong>快速正则结果</strong><span>{results.error || (results.total ? `共 ${results.total} 道匹配题目` : "没有匹配题目")}</span></header>
    {items.length ? <><div>{items.map((question) => <button key={question.id} onClick={() => onChoose(question.id)}><span className="search-type">{question.type}</span><span><strong><MathText text={question.stem} /></strong><small>{question.bankName}{question.tags.length ? ` · ${question.tags.join("、")}` : ""}</small></span><ChevronRight size={16} /></button>)}</div><button className="search-view-all" onClick={onViewAll}>查看全部 {results.total} 道结果<ChevronRight size={16} /></button></> : <div className="search-state">{results.error || "试试“弧垂|导线”这类表达式，搜索范围为首页已选题库。"}</div>}
  </section>;
}
