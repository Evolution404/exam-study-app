"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronRight, RotateCcw, Search, X } from "lucide-react";
import { AppSelect } from "@/app/app-select";
import { ModalPortal } from "@/app/modal-portal";
import { normalizeProgressScope, progressScopeLabel, type ProgressScope } from "@/lib/progress-scope";
import type { BankV6 } from "@/lib/v6-types";

export type SearchBankScope = "current" | "all" | "custom";
export type SearchStatus = "all" | "unanswered" | "wrong" | "favorite";
export type SearchNoteFilter = "all" | "with" | "without";

export interface SearchFilters {
  bankScope: SearchBankScope;
  customBankIds: string[];
  keywordMode: "plain" | "regex";
  status: SearchStatus;
  tag: string;
  noteFilter: SearchNoteFilter;
  progressScopeOverride: ProgressScope | null;
  difficultyMin: string;
  difficultyMax: string;
  attemptsMin: string;
  attemptsMax: string;
  wrongMin: string;
  wrongMax: string;
  lastFrom: string;
  lastTo: string;
}

export function createDefaultSearchFilters(currentBankIds: readonly string[]): SearchFilters {
  return {
    bankScope: currentBankIds.length ? "current" : "all",
    customBankIds: [],
    keywordMode: "plain",
    status: "all",
    tag: "all",
    noteFilter: "all",
    progressScopeOverride: null,
    difficultyMin: "",
    difficultyMax: "",
    attemptsMin: "",
    attemptsMax: "",
    wrongMin: "",
    wrongMax: "",
    lastFrom: "",
    lastTo: "",
  };
}

export function resolveSearchBankIds(filters: SearchFilters, banks: readonly BankV6[], currentBankIds: readonly string[]): string[] {
  const available = new Set(banks.map((bank) => bank.id));
  const source = filters.bankScope === "all"
    ? banks.map((bank) => bank.id)
    : filters.bankScope === "current"
      ? currentBankIds
      : filters.customBankIds;
  return [...new Set(source)].filter((bankId) => available.has(bankId));
}

export function effectiveSearchProgressScope(filters: SearchFilters, settingScope: ProgressScope): ProgressScope {
  return normalizeProgressScope(filters.progressScopeOverride ?? settingScope);
}

export function countActiveSearchFilters(filters: SearchFilters): number {
  return [
    filters.bankScope !== "current",
    filters.keywordMode !== "plain",
    filters.status !== "all",
    filters.tag !== "all",
    filters.noteFilter !== "all",
    filters.progressScopeOverride !== null,
    filters.difficultyMin,
    filters.difficultyMax,
    filters.attemptsMin,
    filters.attemptsMax,
    filters.wrongMin,
    filters.wrongMax,
    filters.lastFrom,
    filters.lastTo,
  ].filter(Boolean).length;
}

function scopeDisplay(scope: ProgressScope) {
  const normalized = normalizeProgressScope(scope);
  return normalized.type === "round" ? "当前复习轮次" : progressScopeLabel(normalized);
}

function numberValue(value: string, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(36_500, Math.trunc(parsed)));
}

export function SearchFilterDrawer({
  open,
  filters,
  settingsProgressScope,
  banks,
  currentBankIds,
  tags,
  onChange,
  onReset,
  onClose,
}: {
  open: boolean;
  filters: SearchFilters;
  settingsProgressScope: ProgressScope;
  banks: BankV6[];
  currentBankIds: string[];
  tags: string[];
  onChange: (filters: SearchFilters) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const hasMoreValues = Boolean(filters.difficultyMin || filters.difficultyMax || filters.attemptsMin || filters.attemptsMax || filters.wrongMin || filters.wrongMax || filters.lastFrom || filters.lastTo);
  const [panel, setPanel] = useState<"main" | "banks" | "progress">("main");
  const [bankQuery, setBankQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(hasMoreValues);
  const inheritedScope = normalizeProgressScope(settingsProgressScope);
  const effectiveScope = effectiveSearchProgressScope(filters, inheritedScope);
  const [customDays, setCustomDays] = useState(effectiveScope.type === "rolling" ? String(effectiveScope.days) : "90");
  const activeCount = countActiveSearchFilters(filters);
  const selectedBankIds = new Set(filters.customBankIds);
  const visibleBanks = useMemo(() => {
    const normalized = bankQuery.trim().toLocaleLowerCase("zh-CN");
    return banks.filter((bank) => !normalized || (bank.displayName || bank.name).toLocaleLowerCase("zh-CN").includes(normalized));
  }, [bankQuery, banks]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (panel === "main") onClose();
        else setPanel("main");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, panel, onClose]);

  if (!open) return null;

  function patch(changes: Partial<SearchFilters>) {
    onChange({ ...filters, ...changes });
  }

  function toggleBank(bankId: string) {
    patch({ bankScope: "custom", customBankIds: selectedBankIds.has(bankId) ? filters.customBankIds.filter((id) => id !== bankId) : [...filters.customBankIds, bankId] });
  }

  function selectProgressScope(scope: ProgressScope | null) {
    patch({ progressScopeOverride: scope });
    setPanel("main");
  }

  const heading = panel === "main" ? "筛选条件" : panel === "banks" ? "指定题库" : "统计范围";
  return <ModalPortal>
    <div className="search-filter-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="search-filter-drawer" role="dialog" aria-modal="true" aria-labelledby="search-filter-title">
        <header className="search-filter-drawer-header">
          {panel !== "main" && <button className="search-filter-icon" aria-label="返回筛选条件" onClick={() => setPanel("main")}><ArrowLeft size={18} /></button>}
          <div><h2 id="search-filter-title">{heading}</h2>{panel === "main" && <span>已设置 {activeCount} 项</span>}{panel === "banks" && <span>已选 {filters.customBankIds.length} 个</span>}</div>
          {panel === "main" && <button className="search-filter-reset" onClick={onReset}><RotateCcw size={14} />重置</button>}
          <button className="search-filter-icon" aria-label="关闭筛选条件" onClick={onClose}><X size={18} /></button>
        </header>

        {panel === "main" && <>
          <div className="search-filter-drawer-body">
            <section className="search-filter-section">
              <h3>搜索范围</h3>
              <div className="search-scope-modes" role="radiogroup" aria-label="搜索范围">
                <button role="radio" aria-checked={filters.bankScope === "current"} className={filters.bankScope === "current" ? "active" : ""} disabled={!currentBankIds.length} onClick={() => patch({ bankScope: "current" })}>已选题库</button>
                <button role="radio" aria-checked={filters.bankScope === "all"} className={filters.bankScope === "all" ? "active" : ""} onClick={() => patch({ bankScope: "all" })}>全部题库</button>
                <button role="radio" aria-checked={filters.bankScope === "custom"} className={filters.bankScope === "custom" ? "active" : ""} onClick={() => { if (filters.customBankIds.length) patch({ bankScope: "custom" }); setPanel("banks"); }}>指定题库</button>
              </div>
              {filters.bankScope === "custom" && <button className="search-filter-setting-row" onClick={() => setPanel("banks")}><span>已指定题库</span><em>{filters.customBankIds.length} 个</em><ChevronRight size={16} /></button>}
            </section>

            <section className="search-filter-section">
              <h3>内容匹配</h3>
              <div className="search-filter-segments" role="radiogroup" aria-label="关键词方式">
                <button role="radio" aria-checked={filters.keywordMode === "plain"} className={filters.keywordMode === "plain" ? "active" : ""} onClick={() => patch({ keywordMode: "plain" })}>包含关键词</button>
                <button role="radio" aria-checked={filters.keywordMode === "regex"} className={filters.keywordMode === "regex" ? "active" : ""} onClick={() => patch({ keywordMode: "regex" })}>正则表达式</button>
              </div>
              <div className="search-filter-select-row">
                <label htmlFor="search-filter-tag">用户标签<AppSelect id="search-filter-tag" ariaLabel="用户标签" value={filters.tag} onValueChange={(tag) => patch({ tag })} options={[{ value: "all", label: "全部标签" }, ...tags.map((tag) => ({ value: tag, label: tag }))]} /></label>
                <label htmlFor="search-filter-note">个人解析<AppSelect id="search-filter-note" ariaLabel="个人解析" value={filters.noteFilter} onValueChange={(noteFilter) => patch({ noteFilter: noteFilter as SearchNoteFilter })} options={[{ value: "all", label: "不限" }, { value: "with", label: "已有解析" }, { value: "without", label: "没有解析" }]} /></label>
              </div>
            </section>

            <section className="search-filter-section">
              <h3>学习状态</h3>
              <button className="search-filter-setting-row" onClick={() => setPanel("progress")}><span>统计范围</span><em className={filters.progressScopeOverride === null ? "following" : ""}>{scopeDisplay(effectiveScope)}{filters.progressScopeOverride === null ? " · 跟随设置" : ""}</em><ChevronRight size={16} /></button>
              <div className="search-status-options" role="radiogroup" aria-label="作答状态">
                {([['all', '全部'], ['unanswered', '未做'], ['wrong', '错题'], ['favorite', '收藏']] as const).map(([value, label]) => <button key={value} role="radio" aria-checked={filters.status === value} className={filters.status === value ? "active" : ""} onClick={() => patch({ status: value })}>{label}</button>)}
              </div>
              <button className="search-filter-more" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>{moreOpen ? "收起统计条件" : "更多统计条件"}<span>{moreOpen ? "−" : "+"}</span></button>
              {moreOpen && <div className="search-filter-more-fields">
                <RangeFields label="难度" min={filters.difficultyMin} max={filters.difficultyMax} minPlaceholder="最低 0" maxPlaceholder="最高 100" onMin={(difficultyMin) => patch({ difficultyMin })} onMax={(difficultyMax) => patch({ difficultyMax })} maxValue={100} />
                <RangeFields label="总作答次数" min={filters.attemptsMin} max={filters.attemptsMax} minPlaceholder="至少" maxPlaceholder="最多" onMin={(attemptsMin) => patch({ attemptsMin })} onMax={(attemptsMax) => patch({ attemptsMax })} />
                <RangeFields label="错误次数" min={filters.wrongMin} max={filters.wrongMax} minPlaceholder="至少" maxPlaceholder="最多" onMin={(wrongMin) => patch({ wrongMin })} onMax={(wrongMax) => patch({ wrongMax })} />
                <div className="search-filter-date-range"><span>最后作答日期</span><div><input aria-label="最后作答开始" type="date" value={filters.lastFrom} onChange={(event) => patch({ lastFrom: event.currentTarget.value })} /><input aria-label="最后作答结束" type="date" value={filters.lastTo} onChange={(event) => patch({ lastTo: event.currentTarget.value })} /></div></div>
              </div>}
            </section>
          </div>
        </>}

        {panel === "banks" && <>
          <div className="search-filter-drawer-body search-bank-picker-body">
            <label className="search-bank-picker-search"><Search size={16} /><input aria-label="搜索题库名称" value={bankQuery} onChange={(event) => setBankQuery(event.currentTarget.value)} placeholder="搜索题库名称" /></label>
            <div className="search-bank-picker-list">
              {visibleBanks.map((bank) => {
                const selected = selectedBankIds.has(bank.id);
                return <button key={bank.id} role="checkbox" aria-checked={selected} className={selected ? "selected" : ""} onClick={() => toggleBank(bank.id)}><span>{bank.displayName || bank.name}</span><i><Check size={14} /></i></button>;
              })}
              {!visibleBanks.length && <p>没有匹配的题库</p>}
            </div>
          </div>
        </>}

        {panel === "progress" && <div className="search-filter-drawer-body search-progress-picker-body">
          <p className="search-progress-hint">默认使用设置页中的“{scopeDisplay(inheritedScope)}”；这里的修改只影响本次搜索。</p>
          <ProgressOption selected={filters.progressScopeOverride === null} title="跟随设置" detail={`当前设置：${scopeDisplay(inheritedScope)}`} onClick={() => selectProgressScope(null)} />
          {[30, 90, 180].map((days) => <ProgressOption key={days} selected={filters.progressScopeOverride?.type === "rolling" && filters.progressScopeOverride.days === days} title={`近 ${days} 天`} detail={`只统计最近 ${days} 天的作答`} onClick={() => selectProgressScope({ type: "rolling", days })} />)}
          <ProgressOption selected={filters.progressScopeOverride?.type === "lifetime"} title="全部时间" detail="统计全部历史作答" onClick={() => selectProgressScope({ type: "lifetime" })} />
          <div className={`search-progress-custom ${filters.progressScopeOverride?.type === "rolling" && ![30, 90, 180].includes(filters.progressScopeOverride.days) ? "selected" : ""}`}>
            <span><strong>自定义天数</strong><small>输入 1–36500 天</small></span>
            <div><input aria-label="自定义统计天数" type="number" min="1" max="36500" value={customDays} onChange={(event) => setCustomDays(event.currentTarget.value)} /><button onClick={() => selectProgressScope({ type: "rolling", days: numberValue(customDays, 90) })}>使用</button></div>
          </div>
        </div>}
      </aside>
    </div>
  </ModalPortal>;
}

function RangeFields({ label, min, max, minPlaceholder, maxPlaceholder, onMin, onMax, maxValue }: { label: string; min: string; max: string; minPlaceholder: string; maxPlaceholder: string; onMin: (value: string) => void; onMax: (value: string) => void; maxValue?: number }) {
  return <label className="search-filter-range"><span>{label}</span><span><input aria-label={`${label}最小值`} type="number" min="0" max={maxValue} value={min} onChange={(event) => onMin(event.currentTarget.value)} placeholder={minPlaceholder} /><input aria-label={`${label}最大值`} type="number" min="0" max={maxValue} value={max} onChange={(event) => onMax(event.currentTarget.value)} placeholder={maxPlaceholder} /></span></label>;
}

function ProgressOption({ selected, title, detail, onClick }: { selected: boolean; title: string; detail: string; onClick: () => void }) {
  return <button className={`search-progress-option ${selected ? "selected" : ""}`} onClick={onClick}><span><strong>{title}</strong><small>{detail}</small></span><i><Check size={14} /></i></button>;
}
