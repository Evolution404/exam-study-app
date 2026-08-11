import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  BookOpenCheck, ChevronRight, Filter, Gauge, History, ListOrdered, RotateCcw, Search, Shuffle, Star, Tags,
} from "lucide-react";
import { db } from "@/lib/db";
import { AppSelect } from "@/app/app-select";
import type { Bank, PracticeFilter, PracticeMode, QuestionType } from "@/lib/types";

const baseModes: Array<{ id: PracticeMode; title: string; detail: string; icon: typeof Shuffle }> = [
  { id: "random30", title: "随机一组", detail: "从已选题库随机抽取", icon: Shuffle },
  { id: "randomCustom", title: "随机指定题数", detail: "本次输入题数，不修改全局配置", icon: Shuffle },
  { id: "sequential", title: "全量顺序练习", detail: "按题库原有顺序练完全部题目", icon: ListOrdered },
  { id: "randomAll", title: "全量随机练习", detail: "练习全部题目，各题型组内随机", icon: Shuffle },
  { id: "wrong", title: "练习错题", detail: "集中练习尚未攻克的错题", icon: RotateCcw },
  { id: "favorite", title: "练习收藏题", detail: "只练习自己收藏的题目", icon: Star },
  { id: "difficult", title: "难题优先", detail: "按动态难度值从高到低练习", icon: Gauge },
  { id: "tag", title: "标签模式", detail: "按一个或多个知识标签练习", icon: Tags },
  { id: "advanced", title: "高级筛选", detail: "组合题型、状态、标签和数量", icon: Filter },
];

const questionTypes: QuestionType[] = ["单选", "多选", "判断"];

function metricValue(value: string) {
  return value === "" ? null : Math.max(0, Math.floor(Number(value)));
}

export function PracticeSetupView({ banks, currentBankIds, onBankChange, onStart, hideHeading = false, groupSize = 30, defaultOrder = "sequential" }: {
  banks: Bank[];
  currentBankIds: string[];
  onBankChange: (bankIds: string[]) => void;
  onStart: (filter: PracticeFilter) => void;
  hideHeading?: boolean;
  groupSize?: number;
  defaultOrder?: PracticeFilter["order"];
}) {
  const [bankIds, setBankIds] = useState(currentBankIds);
  const [mode, setMode] = useState<PracticeMode>("sequential");
  const [types, setTypes] = useState<QuestionType[]>(questionTypes);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagMatch, setTagMatch] = useState<PracticeFilter["tagMatch"]>("any");
  const [status, setStatus] = useState<PracticeFilter["status"]>("all");
  const [order, setOrder] = useState<PracticeFilter["order"]>(defaultOrder);
  const [limit, setLimit] = useState<number | null>(null);
  const [customRandomCount, setCustomRandomCount] = useState(String(groupSize));
  const [keyword, setKeyword] = useState("");
  const [keywordMode, setKeywordMode] = useState<PracticeFilter["keywordMode"]>("plain");
  const [totalAttemptsMin, setTotalAttemptsMin] = useState("");
  const [totalAttemptsMax, setTotalAttemptsMax] = useState("");
  const [wrongAttemptsMin, setWrongAttemptsMin] = useState("");
  const [wrongAttemptsMax, setWrongAttemptsMax] = useState("");
  const [difficultyMin, setDifficultyMin] = useState("");
  const [difficultyMax, setDifficultyMax] = useState("");
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
    const next = bankIds.includes(bankId) ? bankIds.filter((id) => id !== bankId) : [...bankIds, bankId];
    setBankIds(next);
    onBankChange(next);
  }

  function start() {
    const requestedRandomCount = Math.floor(Number(customRandomCount));
    const filter: PracticeFilter = {
      bankIds,
      mode,
      types: mode === "advanced" ? types : questionTypes,
      tags: mode === "tag" || mode === "advanced" ? selectedTags : [],
      tagMatch,
      status: mode === "wrong" ? "wrong" : mode === "favorite" ? "favorite" : mode === "advanced" ? status : "all",
      order: mode === "random30" || mode === "randomCustom" || mode === "randomAll" ? "random" : mode === "difficult" ? "difficulty" : mode === "advanced" ? order : "sequential",
      limit: mode === "random30" ? groupSize : mode === "randomCustom" ? requestedRandomCount : mode === "advanced" ? limit : null,
      keyword: mode === "advanced" ? keyword : "",
      keywordMode,
      totalAttemptsMin: mode === "advanced" ? metricValue(totalAttemptsMin) : null,
      totalAttemptsMax: mode === "advanced" ? metricValue(totalAttemptsMax) : null,
      wrongAttemptsMin: mode === "advanced" ? metricValue(wrongAttemptsMin) : null,
      wrongAttemptsMax: mode === "advanced" ? metricValue(wrongAttemptsMax) : null,
      difficultyMin: mode === "advanced" ? metricValue(difficultyMin) : null,
      difficultyMax: mode === "advanced" ? metricValue(difficultyMax) : null,
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
  const difficultyLow = metricValue(difficultyMin);
  const difficultyHigh = metricValue(difficultyMax);
  const metricError = totalMin !== null && totalMax !== null && totalMin > totalMax
    ? "总作答次数的最少值不能大于最多值"
    : wrongMin !== null && wrongMax !== null && wrongMin > wrongMax
      ? "错误次数的最少值不能大于最多值"
      : (difficultyLow !== null && difficultyLow > 100) || (difficultyHigh !== null && difficultyHigh > 100)
        ? "难度值范围必须在 0–100 之间"
        : difficultyLow !== null && difficultyHigh !== null && difficultyLow > difficultyHigh
          ? "最低难度不能大于最高难度"
          : "";
  const dateError = lastAttemptFrom && lastAttemptTo && lastAttemptFrom > lastAttemptTo ? "开始日期不能晚于结束日期" : "";
  const requestedRandomCount = Math.floor(Number(customRandomCount));
  const customRandomError = mode === "randomCustom" && (!Number.isFinite(requestedRandomCount) || requestedRandomCount < 1 || requestedRandomCount > questions.length)
    ? `请输入 1–${Math.max(1, questions.length)} 之间的题数`
    : "";
  const disabled = !bankIds.length || Boolean(customRandomError) || (mode === "tag" && !selectedTags.length) || (mode === "advanced" && (!types.length || Boolean(regexError) || Boolean(metricError) || Boolean(dateError)));
  return <>
    {!hideHeading && <div className="page-heading compact"><div><p className="eyebrow">自由安排练习</p><h1>选择练习模式</h1><p>全量顺序、错题、标签或任意组合筛选，进度都会自动保存。</p></div></div>}
    <section className="practice-setup-card">
      <div className="setup-bank"><span>练习题库（可单选或多选）</span><div className="scope-bank-list">{banks.map((bank) => <button key={bank.id} aria-pressed={bankIds.includes(bank.id)} className={bankIds.includes(bank.id) ? "selected" : ""} onClick={() => toggleBank(bank.id)}><i /> <span><strong>{bank.displayName || bank.name}</strong><small>{bank.questionCount} 题</small></span></button>)}</div></div>
      <div className="mode-grid">{baseModes.map(({ id, title, detail, icon: Icon }) => <button key={id} className={mode === id ? "active" : ""} onClick={() => setMode(id)}><Icon size={20} /><strong>{id === "random30" ? `随机 ${groupSize} 题` : title}</strong><small>{id === "random30" ? `${detail} ${groupSize} 题` : detail}</small></button>)}</div>

      {mode === "randomCustom" && <div className="custom-random-count"><div><strong>本次随机抽取题数</strong><small>只对即将开始的这次练习生效，不修改答题配置中的每组题数。</small></div><label>题数<input aria-label="本次随机题数" type="number" min="1" max={Math.max(1, questions.length)} step="1" inputMode="numeric" value={customRandomCount} onChange={(event) => setCustomRandomCount(event.target.value)} /></label>{customRandomError && <p className="filter-error">{customRandomError}</p>}</div>}

      {(mode === "tag" || mode === "advanced") && <div className="filter-section"><div className="filter-title"><Tags size={17} /><strong>用户标签</strong><small>{selectedTags.length ? `已选 ${selectedTags.length} 个` : mode === "tag" ? "请选择标签" : "不限制标签"}</small></div>{tags.length ? <><div className="chip-list">{tags.map((tag) => <button key={tag} className={selectedTags.includes(tag) ? "selected" : ""} onClick={() => toggleTag(tag)}>{tag}</button>)}</div>{selectedTags.length > 1 && <div className="tag-match-control"><span>多个标签：</span><button className={tagMatch === "any" ? "selected" : ""} onClick={() => setTagMatch("any")}>符合任意一个</button><button className={tagMatch === "all" ? "selected" : ""} onClick={() => setTagMatch("all")}>同时符合全部</button></div>}</> : <p className="filter-empty">当前题库还没有用户标签，可在练习中编辑题目并添加。</p>}</div>}

      {mode === "advanced" && <>
        <div className="advanced-query-grid">
          <div className="filter-section keyword-filter"><div className="filter-title"><Search size={17} /><strong>关键词匹配</strong><small>题干、选项和用户标签</small></div><div className="query-row"><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={keywordMode === "regex" ? "例如：弧垂|导线|杆塔" : "输入要查找的文字"} /><AppSelect ariaLabel="关键词方式" value={keywordMode} onValueChange={(value) => setKeywordMode(value as PracticeFilter["keywordMode"])} options={[{ value: "plain", label: "包含关键词" }, { value: "regex", label: "正则表达式" }]} /></div>{regexError && <p className="filter-error">{regexError}</p>}</div>
          <div className="filter-section history-filter"><div className="filter-title"><History size={17} /><strong>历史作答与难度</strong><small>留空表示不限</small></div><div className="metric-grid"><label>总作答最少<input type="number" min="0" step="1" inputMode="numeric" value={totalAttemptsMin} onChange={(event) => setTotalAttemptsMin(event.target.value)} placeholder="0" /></label><label>总作答最多<input type="number" min="0" step="1" inputMode="numeric" value={totalAttemptsMax} onChange={(event) => setTotalAttemptsMax(event.target.value)} placeholder="不限" /></label><label>错误最少<input type="number" min="0" step="1" inputMode="numeric" value={wrongAttemptsMin} onChange={(event) => setWrongAttemptsMin(event.target.value)} placeholder="0" /></label><label>错误最多<input type="number" min="0" step="1" inputMode="numeric" value={wrongAttemptsMax} onChange={(event) => setWrongAttemptsMax(event.target.value)} placeholder="不限" /></label><label>最低难度<input type="number" min="0" max="100" step="1" inputMode="numeric" value={difficultyMin} onChange={(event) => setDifficultyMin(event.target.value)} placeholder="0" /></label><label>最高难度<input type="number" min="0" max="100" step="1" inputMode="numeric" value={difficultyMax} onChange={(event) => setDifficultyMax(event.target.value)} placeholder="100" /></label></div>{metricError && <p className="filter-error">{metricError}</p>}<div className="date-range-filter"><span>上次作答日期</span><div><label>开始日期<input type="date" value={lastAttemptFrom} onInput={(event) => setLastAttemptFrom(event.currentTarget.value)} /></label><span>至</span><label>结束日期<input type="date" value={lastAttemptTo} onInput={(event) => setLastAttemptTo(event.currentTarget.value)} /></label>{(lastAttemptFrom || lastAttemptTo) && <button className="clear-date-button" type="button" onClick={() => { setLastAttemptFrom(""); setLastAttemptTo(""); }}>清除日期</button>}</div>{dateError && <p className="filter-error">{dateError}</p>}</div></div>
        </div>
        <div className="advanced-grid">
          <div className="filter-section"><div className="filter-title"><BookOpenCheck size={17} /><strong>题型</strong></div><div className="chip-list">{questionTypes.map((type) => <button key={type} className={types.includes(type) ? "selected" : ""} onClick={() => toggleType(type)}>{type}</button>)}</div></div>
          <label htmlFor="practice-status-select">作答状态<AppSelect id="practice-status-select" ariaLabel="作答状态" value={status} onValueChange={(value) => setStatus(value as PracticeFilter["status"])} options={[{ value: "all", label: "全部题目" }, { value: "unanswered", label: "从未作答" }, { value: "wrong", label: "当前错题" }, { value: "favorite", label: "已收藏" }]} /></label>
          <label htmlFor="practice-order-select">题目顺序<AppSelect id="practice-order-select" ariaLabel="题目顺序" value={order} onValueChange={(value) => setOrder(value as PracticeFilter["order"])} options={[{ value: "sequential", label: "题库顺序" }, { value: "random", label: "随机打乱" }, { value: "difficulty", label: "难题优先" }]} /></label>
          <label htmlFor="practice-limit-select">练习数量<AppSelect id="practice-limit-select" ariaLabel="练习数量" value={limit === null ? "all" : String(limit)} onValueChange={(value) => setLimit(value === "all" ? null : Number(value))} options={[{ value: "all", label: "全部符合条件的题" }, { value: "30", label: "30 题" }, { value: "50", label: "50 题" }, { value: "100", label: "100 题" }]} /></label>
        </div>
        <p className="advanced-hint"><Filter size={14} />以上已填写条件采用“并且”关系，题目必须同时满足。</p>
      </>}

      <div className="setup-footer"><div><strong>{questions.length.toLocaleString()}</strong><span>已选题库题目</span></div><button className="primary" disabled={disabled} onClick={start}>开始练习<ChevronRight size={18} /></button></div>
    </section>
  </>;
}
