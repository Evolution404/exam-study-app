"use client";

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { filterTagOptions, type TagMatchMode } from "@/lib/question/tag-filter";

export function TagMultiSelect({ tags, selected, onChange, matchMode = "any", onMatchModeChange, ariaLabel = "搜索标签", emptyLabel = "当前范围没有用户标签" }: {
  tags: readonly string[];
  selected: readonly string[];
  onChange: (tags: string[]) => void;
  matchMode?: TagMatchMode;
  onMatchModeChange?: (mode: TagMatchMode) => void;
  ariaLabel?: string;
  emptyLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const visibleTags = useMemo(() => filterTagOptions(tags, query), [tags, query]);

  function toggle(tag: string) {
    onChange(selected.includes(tag) ? selected.filter((item) => item !== tag) : [...selected, tag]);
  }

  return <div className="tag-multi-select">
    <div className="tag-multi-search"><Search size={15} /><input aria-label={ariaLabel} value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索标签" />{query && <button type="button" className="tag-multi-clear-search" aria-label="清空标签搜索" onClick={() => setQuery("")}><X size={14} /></button>}</div>
    <div className="tag-multi-summary"><span>{selected.length ? `已选 ${selected.length} 个标签` : "不限标签"}</span>{selected.length > 0 && <button type="button" className="tag-multi-clear" onClick={() => onChange([])}>清空</button>}</div>
    {visibleTags.length ? <div className="tag-multi-options" role="group" aria-label="标签多选">{visibleTags.map((tag) => <button type="button" key={tag} aria-pressed={selected.includes(tag)} className={selected.includes(tag) ? "selected" : ""} onClick={() => toggle(tag)}>{tag}</button>)}</div> : <p className="filter-empty">{tags.length ? "没有匹配的标签" : emptyLabel}</p>}
    {selected.length > 1 && onMatchModeChange && <div className="tag-multi-match" role="radiogroup" aria-label="多标签匹配方式"><span>多个标签</span><button type="button" role="radio" aria-checked={matchMode === "any"} className={matchMode === "any" ? "selected" : ""} onClick={() => onMatchModeChange("any")}>符合任意一个</button><button type="button" role="radio" aria-checked={matchMode === "all"} className={matchMode === "all" ? "selected" : ""} onClick={() => onMatchModeChange("all")}>同时符合全部</button></div>}
  </div>;
}
