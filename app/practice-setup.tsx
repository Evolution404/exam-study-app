import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  BookOpenCheck, ChevronRight, Filter, History, ListOrdered, RotateCcw, Search, Shuffle, Tags,
} from "lucide-react";
import { db } from "@/lib/db";
import type { Bank, PracticeFilter, PracticeMode, QuestionType } from "@/lib/types";

const modes: Array<{ id: PracticeMode; title: string; detail: string; icon: typeof Shuffle }> = [
  { id: "random30", title: "随机 30 题", detail: "从已选题库随机抽取一组", icon: Shuffle },
  { id: "sequential", title: "全量顺序练习", detail: "按题库原有顺序练完全部题目", icon: ListOrdered },
  { id: "wrong", title: "错题模式", detail: "集中练习曾经答错的题目", icon: RotateCcw },
  { id: "tag", title: "标签模式", detail: "按一个或多个知识标签练习", icon: Tags },
  { id: "advanced", title: "高级筛选", detail: "组合题型、状态、标签和数量", icon: Filter },
];

const questionTypes: QuestionType[] = ["单选", "多选", "判断"];

function metricValue(value: string) {
  return value === "" ? null : Math.max(0, Math.floor(Number(value)));
}

export function PracticeSetupView({ banks, currentBankIds, onBankChange, onStart }: {
  banks: Bank[];
  currentBankIds: string[];
  onBankChange: (bankIds: string[]) => void;
  onStart: (filter: PracticeFilter) => void;
}) {
  const [bankIds, setBankIds] = useState(currentBankIds);
  const [mode, setMode] = useState<PracticeMode>("sequential");
  const [types, setTypes] = useState<QuestionType[]>(questionTypes);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagMatch, setTagMatch] = useState<PracticeFilter["tagMatch"]>("any");
  const [status, setStatus] = useState<PracticeFilter["status"]>("all");
  const [order, setOrder] = useState<PracticeFilter["order"]>("sequential");
  const [limit, setLimit] = useState<number | null>(null);
  const [keyword, setKeyword] = useState("");
  const [keywordMode, setKeywordMode] = useState<PracticeFilter["keywordMode"]>("plain");
  const [totalAttemptsMin, setTotalAttemptsMin] = useState("");
  const [totalAttemptsMax, setTotalAttemptsMax] = useState("");
  const [wrongAttemptsMin, setWrongAttemptsMin] = useState("");
  const [wrongAttemptsMax, setWrongAttemptsMax] = useState("");
  const [lastAttemptFrom, setLastAttemptFrom] = useState("");
  const [lastAttemptTo, setLastAttemptTo] = useState("");
  const bankKey = bankIds.join("|");
  const questions = useLiveQuery(async () => (await Promise.all(bankIds.map((bankId) => db.questions.where("bankId").equals(bankId).toArray()))).flat(), [bankKey]) ?? [];
  const tags = [...new Set(questions.flatMap((question) => question.tags))].sort((a, b) => a.localeCompare(b, "zh-CN"));

  function toggleType(type: QuestionType) {
    setTypes(types.includes(type) ? types.filter((item) => item !== type) : [...types, type]);
  }

  function toggleTag(tag: string) {
    setSelectedTags(selectedTags.includes(tag) ? selectedTags.filter((item) => item !== tag) : [...selectedTags, tag]);
  }

  function toggleBank(bankId: string) {
    const next = bankIds.includes(bankId)
      ? bankIds.length > 1 ? bankIds.filter((id) => id !== bankId) : bankIds
      : [...bankIds, bankId];
    setBankIds(next);
    onBankChange(next);
  }

  function start() {
    const filter: PracticeFilter = {
      bankIds,
      mode,
      types: mode === "advanced" ? types : questionTypes,
      tags: mode === "tag" || mode === "advanced" ? selectedTags : [],
      tagMatch,
      status: mode === "wrong" ? "wrong" : mode === "advanced" ? status : "all",
      order: mode === "random30" ? "random" : mode === "advanced" ? order : "sequential",
      limit: mode === "random30" ? 30 : mode === "advanced" ? limit : null,
      keyword: mode === "advanced" ? keyword : "",
      keywordMode,
      totalAttemptsMin: mode === "advanced" ? metricValue(totalAttemptsMin) : null,
      totalAttemptsMax: mode === "advanced" ? metricValue(totalAttemptsMax) : null,
      wrongAttemptsMin: mode === "advanced" ? metricValue(wrongAttemptsMin) : null,
      wrongAttemptsMax: mode === "advanced" ? metricValue(wrongAttemptsMax) : null,
      lastAttemptFrom: mode === "advanced" ? lastAttemptFrom : "",
      lastAttemptTo: mode === "advanced" ? lastAttemptTo : "",
    };
    onStart(filter);
  }

  let regexError = "";
  if (mode === "advanced" && keywordMode === "regex" && keyword.trim()) {
    try { new RegExp(keyword); } catch { regexError = "正则表达式格式不正确"; }
  }
  const totalMin = metricValue(totalAttemptsMin);
  const totalMax = metricValue(totalAttemptsMax);
  const wrongMin = metricValue(wrongAttemptsMin);
  const wrongMax = metricValue(wrongAttemptsMax);
  const metricError = totalMin !== null && totalMax !== null && totalMin > totalMax
    ? "总作答次数的最少值不能大于最多值"
    : wrongMin !== null && wrongMax !== null && wrongMin > wrongMax
      ? "错误次数的最少值不能大于最多值"
      : "";
  const dateError = lastAttemptFrom && lastAttemptTo && lastAttemptFrom > lastAttemptTo ? "开始日期不能晚于结束日期" : "";
  const disabled = !bankIds.length || (mode === "tag" && !selectedTags.length) || (mode === "advanced" && (!types.length || Boolean(regexError) || Boolean(metricError) || Boolean(dateError)));
  return <>
    <div className="page-heading compact"><div><p className="eyebrow">自由安排练习</p><h1>选择练习模式</h1><p>全量顺序、错题、标签或任意组合筛选，进度都会自动保存。</p></div></div>
    <section className="practice-setup-card">
      <div className="setup-bank"><span>练习题库（可单选或多选）</span><div className="scope-bank-list">{banks.map((bank) => <button key={bank.id} aria-pressed={bankIds.includes(bank.id)} className={bankIds.includes(bank.id) ? "selected" : ""} onClick={() => toggleBank(bank.id)}><i /> <span><strong>{bank.name}</strong><small>{bank.questionCount} 题</small></span></button>)}</div></div>
      <div className="mode-grid">{modes.map(({ id, title, detail, icon: Icon }) => <button key={id} className={mode === id ? "active" : ""} onClick={() => setMode(id)}><Icon size={20} /><strong>{title}</strong><small>{detail}</small></button>)}</div>

      {(mode === "tag" || mode === "advanced") && <div className="filter-section"><div className="filter-title"><Tags size={17} /><strong>用户标签</strong><small>{selectedTags.length ? `已选 ${selectedTags.length} 个` : mode === "tag" ? "请选择标签" : "不限制标签"}</small></div>{tags.length ? <><div className="chip-list">{tags.map((tag) => <button key={tag} className={selectedTags.includes(tag) ? "selected" : ""} onClick={() => toggleTag(tag)}>{tag}</button>)}</div>{selectedTags.length > 1 && <div className="tag-match-control"><span>多个标签：</span><button className={tagMatch === "any" ? "selected" : ""} onClick={() => setTagMatch("any")}>符合任意一个</button><button className={tagMatch === "all" ? "selected" : ""} onClick={() => setTagMatch("all")}>同时符合全部</button></div>}</> : <p className="filter-empty">当前题库还没有用户标签，可在练习中编辑题目并添加。</p>}</div>}

      {mode === "advanced" && <>
        <div className="advanced-query-grid">
          <div className="filter-section keyword-filter"><div className="filter-title"><Search size={17} /><strong>关键词匹配</strong><small>题干、选项和用户标签</small></div><div className="query-row"><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={keywordMode === "regex" ? "例如：弧垂|导线|杆塔" : "输入要查找的文字"} /><select value={keywordMode} onChange={(event) => setKeywordMode(event.target.value as PracticeFilter["keywordMode"])}><option value="plain">包含关键词</option><option value="regex">正则表达式</option></select></div>{regexError && <p className="filter-error">{regexError}</p>}</div>
          <div className="filter-section history-filter"><div className="filter-title"><History size={17} /><strong>历史作答统计</strong><small>留空表示不限</small></div><div className="metric-grid"><label>总作答最少<input type="number" min="0" step="1" inputMode="numeric" value={totalAttemptsMin} onChange={(event) => setTotalAttemptsMin(event.target.value)} placeholder="0" /></label><label>总作答最多<input type="number" min="0" step="1" inputMode="numeric" value={totalAttemptsMax} onChange={(event) => setTotalAttemptsMax(event.target.value)} placeholder="不限" /></label><label>错误最少<input type="number" min="0" step="1" inputMode="numeric" value={wrongAttemptsMin} onChange={(event) => setWrongAttemptsMin(event.target.value)} placeholder="0" /></label><label>错误最多<input type="number" min="0" step="1" inputMode="numeric" value={wrongAttemptsMax} onChange={(event) => setWrongAttemptsMax(event.target.value)} placeholder="不限" /></label></div>{metricError && <p className="filter-error">{metricError}</p>}<div className="date-range-filter"><span>上次作答日期</span><div><label>开始日期<input type="date" value={lastAttemptFrom} onInput={(event) => setLastAttemptFrom(event.currentTarget.value)} /></label><span>至</span><label>结束日期<input type="date" value={lastAttemptTo} onInput={(event) => setLastAttemptTo(event.currentTarget.value)} /></label></div>{dateError && <p className="filter-error">{dateError}</p>}</div></div>
        </div>
        <div className="advanced-grid">
          <div className="filter-section"><div className="filter-title"><BookOpenCheck size={17} /><strong>题型</strong></div><div className="chip-list">{questionTypes.map((type) => <button key={type} className={types.includes(type) ? "selected" : ""} onClick={() => toggleType(type)}>{type}</button>)}</div></div>
          <label>作答状态<select value={status} onChange={(event) => setStatus(event.target.value as PracticeFilter["status"])}><option value="all">全部题目</option><option value="unanswered">从未作答</option><option value="wrong">至少错过一次</option></select></label>
          <label>题目顺序<select value={order} onChange={(event) => setOrder(event.target.value as PracticeFilter["order"])}><option value="sequential">题库顺序</option><option value="random">随机打乱</option></select></label>
          <label>练习数量<select value={limit ?? "all"} onChange={(event) => setLimit(event.target.value === "all" ? null : Number(event.target.value))}><option value="all">全部符合条件的题</option><option value="30">30 题</option><option value="50">50 题</option><option value="100">100 题</option></select></label>
        </div>
        <p className="advanced-hint"><Filter size={14} />以上已填写条件采用“并且”关系，题目必须同时满足。</p>
      </>}

      <div className="setup-footer"><div><strong>{questions.length.toLocaleString()}</strong><span>已选题库题目</span></div><button className="primary" disabled={disabled} onClick={start}>开始练习<ChevronRight size={18} /></button></div>
    </section>
  </>;
}
