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
import type { BankV7, QuestionTypeV7 } from "@/lib/db/v7-types";
import { createSearchMatcher, SEARCH_CONTENT_SCOPE_OPTIONS, searchFieldsForQuestion, type SearchContentScope } from "@/app/search/search-matching";

type QuestionType = QuestionTypeV7;
const TYPE_ORDER: QuestionType[] = ["单选", "多选", "判断", "计算"];

/**
 * The topbar quick-search box, self-contained so the caret is owned by this
 * small component's own state instead of the StudyApp top level.  Keeps its own
 * draft query and open flag; only the final keyword is forwarded on open.
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
    // Keep the all-fields path compatible with existing callers while still
    // carrying a focused scope into the full search page.
    if (contentScope === "all") onOpenSearch(draft.trim(), questionId);
    else onOpenSearch(draft.trim(), questionId, contentScope);
  }

  return <div ref={boxRef} className={`searchbox ${open && draft.trim() ? "results-open" : ""}`}>
    <Hint label="搜索主页与高级筛选"><button className="search-page-trigger" aria-label="进入搜索主页" onClick={() => openSearch()}><Search size={17} /></button></Hint>
    <input aria-label="快速正则搜索题目、选项、标签或解析" value={draft} onFocus={() => { setOpen(true); }} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setDraft(""); setOpen(false); } else if (event.key === "Enter") { event.currentTarget.blur(); openSearch(); } }} placeholder="快速正则搜索；点击图标进入搜索主页" />
    <AppSelect ariaLabel="快速搜索范围" className="quick-search-scope" contentClassName="search-scope-select-content quick-search-scope-content" value={contentScope} onValueChange={(value) => { setContentScope(value as SearchContentScope); setOpen(true); }} options={SEARCH_CONTENT_SCOPE_OPTIONS} />
    {draft && <button className="search-clear" aria-label="清除搜索" onClick={() => { setDraft(""); setOpen(false); }}><X size={15} /></button>}
    <QuickSearchResults enabled={open && Boolean(draft.trim())} query={draft} contentScope={contentScope} bankIds={activeBankIds.length ? activeBankIds : banks.map((bank) => bank.id)} onChoose={(questionId) => openSearch(questionId)} onViewAll={() => openSearch()} />
  </div>;
}

function QuickSearchResults({ enabled, query, contentScope, bankIds, onChoose, onViewAll }: { enabled: boolean; query: string; contentScope: SearchContentScope; bankIds: string[]; onChoose: (questionId: string) => void; onViewAll: () => void }) {
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setTimeout(() => setDebouncedQuery(query), 160);
    return () => window.clearTimeout(timer);
  }, [enabled, query]);
  const normalizedQuery = debouncedQuery.trim();
  const bankKey = bankIds.join("|");
  // 题库只随题库范围变化查询一次；输入词不再触发 IndexedDB 查询/映射，
  // 避免数据量大时每次按键都做异步重查询干扰输入框光标。
  const data = useLiveQuery(async () => {
    if (!enabled || !bankIds.length) return undefined;
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
  }, [bankKey, enabled]);

  // 输入词变化只做同步过滤，不触碰 IndexedDB。
  const results = useMemo(() => {
    if (!normalizedQuery || !bankIds.length) return { items: [] as ReturnType<typeof toQuestionViewModel>[], total: 0, error: "" };
    const matcher = createSearchMatcher(normalizedQuery, "regex");
    if (matcher.error) return { items: [], total: 0, error: matcher.error };
    const questions = data?.questions ?? [];
    const notesByQuestion = data?.notes ?? new Map<string, string>();
    const matched = questions.filter((question) => matcher.matches(searchFieldsForQuestion(question, notesByQuestion.get(question.id) ?? "", contentScope)));
    const grouped = TYPE_ORDER.flatMap((type) => matched.filter((question) => question.type === type));
    return { items: grouped.slice(0, 8), total: grouped.length, error: "" };
  }, [normalizedQuery, data, bankIds.length, contentScope]);

  if (!enabled || !normalizedQuery) return null;
  if (data === undefined) return <section className="search-results"><div className="search-state"><LoaderCircle className="spin" size={17} />正在搜索…</div></section>;
  return <section className="search-results" aria-label="搜索结果">
    <header><strong>快速正则结果</strong><span>{results.error || (results.total ? `共 ${results.total} 道匹配题目` : "没有匹配题目")}</span></header>
    {results.items.length ? <><div>{results.items.map((question) => <button key={question.id} onClick={() => onChoose(question.id)}><span className="search-type">{question.type}</span><span><strong><MathText text={question.stem} /></strong><small>{question.bankName}{question.tags.length ? ` · ${question.tags.join("、")}` : ""}</small></span><ChevronRight size={16} /></button>)}</div><button className="search-view-all" onClick={onViewAll}>查看全部 {results.total} 道结果<ChevronRight size={16} /></button></> : <div className="search-state">{results.error || "试试“弧垂|导线”这类表达式，搜索范围为首页已选题库。"}</div>}
  </section>;
}
