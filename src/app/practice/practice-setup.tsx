/* eslint-disable jsx-a11y/label-has-associated-control */
import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Filter, Gauge, History, ListOrdered, RotateCcw, Search, Shuffle, Star, Tags } from "lucide-react";
import { dbV7, getQuestionsForBanksV7 } from "@/lib/db/db-v7";
import { isQuestionDoneInScope, normalizeProgressScope, type ProgressScope } from "@/lib/practice/progress-scope";
import { AppSelect } from "@/app/ui/app-select";
import { ProgressScopeSetting } from "@/app/practice/progress-scope-setting";
import { ScopeSummaryChips } from "@/app/ui/scope-summary-chips";
import type { BankV7, QuestionTypeV7, ReviewRound } from "@/lib/db/v7-types";

export type V7PracticeMode = "random30" | "randomCustom" | "sequential" | "randomAll" | "wrong" | "favorite" | "difficult" | "tag" | "advanced";

export interface V7PracticeFilter {
  bankIds: string[];
  mode: V7PracticeMode;
  types: QuestionTypeV7[];
  tags: string[];
  tagMatch: "any" | "all";
  status: "all" | "unanswered" | "wrong" | "favorite";
  order: "sequential" | "random" | "difficulty";
  limit: number | null;
  keyword: string;
  keywordMode: "plain" | "regex";
  totalAttemptsMin: number | null;
  totalAttemptsMax: number | null;
  wrongAttemptsMin: number | null;
  wrongAttemptsMax: number | null;
  difficultyMin: number | null;
  difficultyMax: number | null;
  lastAttemptFrom: string;
  lastAttemptTo: string;
  progressScope: ProgressScope;
  reviewRoundId?: string;
  /** 调用方提供的 run 展示标签（组合式文案）；缺省时 startPractice 按 mode 推导。 */
  modeLabel?: string;
}

const baseModes: Array<{ id: V7PracticeMode; title: string; detail: string; icon: typeof Shuffle }> = [
  { id: "random30", title: "随机一组", detail: "从已选题库随机抽取", icon: Shuffle },
  { id: "randomCustom", title: "随机指定题数", detail: "本次输入题数，不修改全局配置", icon: Shuffle },
  { id: "sequential", title: "全量顺序练习", detail: "按题库顺序练完全部题目", icon: ListOrdered },
  { id: "randomAll", title: "全量随机练习", detail: "全部题目随机排列", icon: Shuffle },
  { id: "wrong", title: "练习错题", detail: "集中练习当前口径下的错题", icon: RotateCcw },
  { id: "favorite", title: "练习收藏题", detail: "只练习自己收藏的题目", icon: Star },
  { id: "difficult", title: "难题优先", detail: "按终身动态难度值排序", icon: Gauge },
  { id: "tag", title: "标签模式", detail: "按知识标签练习", icon: Tags },
  { id: "advanced", title: "高级筛选", detail: "组合题型、状态、标签和数量", icon: Filter },
];

const questionTypes: QuestionTypeV7[] = ["单选", "多选", "判断", "计算"];

function metricValue(value: string) {
  return value === "" ? null : Math.max(0, Math.floor(Number(value)));
}

export function PracticeSetupView({ banks, currentBankIds, onBankChange, onStart, hideHeading = false, groupSize = 30, defaultOrder = "sequential", progressScope = { type: "rolling", days: 90 }, rounds = [] }: {
  banks: BankV7[];
  currentBankIds: string[];
  onBankChange: (bankIds: string[]) => void;
  onStart: (filter: V7PracticeFilter) => void;
  hideHeading?: boolean;
  groupSize?: number;
  defaultOrder?: V7PracticeFilter["order"];
  progressScope?: ProgressScope;
  rounds?: readonly ReviewRound[];
}) {
  const [bankIds, setBankIds] = useState(currentBankIds);
  const [mode, setMode] = useState<V7PracticeMode>("sequential");
  const [types, setTypes] = useState<QuestionTypeV7[]>(questionTypes);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagMatch, setTagMatch] = useState<"any" | "all">("any");
  const [status, setStatus] = useState<V7PracticeFilter["status"]>("all");
  const [order, setOrder] = useState<V7PracticeFilter["order"]>(defaultOrder);
  const [limit, setLimit] = useState<number | null>(null);
  const [customRandomCount, setCustomRandomCount] = useState(String(groupSize));
  const [keyword, setKeyword] = useState("");
  const [keywordMode, setKeywordMode] = useState<V7PracticeFilter["keywordMode"]>("plain");
  const [totalAttemptsMin, setTotalAttemptsMin] = useState("");
  const [totalAttemptsMax, setTotalAttemptsMax] = useState("");
  const [wrongAttemptsMin, setWrongAttemptsMin] = useState("");
  const [wrongAttemptsMax, setWrongAttemptsMax] = useState("");
  const [difficultyMin, setDifficultyMin] = useState("");
  const [difficultyMax, setDifficultyMax] = useState("");
  const [lastAttemptFrom, setLastAttemptFrom] = useState("");
  const [lastAttemptTo, setLastAttemptTo] = useState("");
  const [reviewRoundId, setReviewRoundId] = useState("");
  const [advancedScope, setAdvancedScope] = useState<ProgressScope | null>(null);
  const bankKey = bankIds.join("|");
  const dataset = useLiveQuery(async () => {
    const [questions, stats, roundsProgress] = await Promise.all([
      getQuestionsForBanksV7(bankIds),
      dbV7.attemptStats.toArray(),
      dbV7.reviewRoundProgress.toArray(),
    ]);
    return { questions, stats, roundsProgress };
  }, [bankKey]) ?? { questions: [], stats: [], roundsProgress: [] };
  const tags = useMemo(() => [...new Set(dataset.questions.flatMap((question) => question.tags))].sort((a, b) => a.localeCompare(b, "zh-CN")), [dataset.questions]);
  const normalizedScope = normalizeProgressScope(progressScope);
  const effectiveScope = normalizeProgressScope(advancedScope ?? normalizedScope);
  const effectiveScopeLabel = effectiveScope.type === "rolling" ? `近 ${effectiveScope.days} 天`
    : effectiveScope.type === "lifetime" ? "全部时间"
      : rounds.find((round) => round.id === effectiveScope.roundId)?.name ?? "当前复习轮次";
  const [referenceTime] = useState(Date.now);
  const doneCount = useMemo(() => dataset.questions.filter((question) => isQuestionDoneInScope(question.id, effectiveScope, dataset.stats, dataset.roundsProgress, referenceTime)).length, [dataset.questions, dataset.stats, dataset.roundsProgress, effectiveScope, referenceTime]);

  function toggleType(type: QuestionTypeV7) { setTypes(types.includes(type) ? types.filter((item) => item !== type) : [...types, type]); }
  function toggleTag(tag: string) { setSelectedTags(selectedTags.includes(tag) ? selectedTags.filter((item) => item !== tag) : [...selectedTags, tag]); }
  function toggleBank(bankId: string) {
    const next = bankIds.includes(bankId) ? bankIds.filter((id) => id !== bankId) : [...bankIds, bankId];
    setBankIds(next);
    if (reviewRoundId) setReviewRoundId("");
    onBankChange(next);
  }

  function start() {
    const requestedRandomCount = Math.floor(Number(customRandomCount));
    onStart({
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
      progressScope: effectiveScope,
      ...(reviewRoundId ? { reviewRoundId } : {}),
    });
  }

  let regexError = "";
  if (mode === "advanced" && keywordMode === "regex" && keyword.trim()) { try { new RegExp(keyword); } catch { regexError = "正则表达式格式不正确"; } }
  const totalMin = metricValue(totalAttemptsMin); const totalMax = metricValue(totalAttemptsMax);
  const wrongMin = metricValue(wrongAttemptsMin); const wrongMax = metricValue(wrongAttemptsMax);
  const difficultyLow = metricValue(difficultyMin); const difficultyHigh = metricValue(difficultyMax);
  const metricError = totalMin !== null && totalMax !== null && totalMin > totalMax ? "总作答次数的最少值不能大于最多值" : wrongMin !== null && wrongMax !== null && wrongMin > wrongMax ? "错误次数的最少值不能大于最多值" : (difficultyLow !== null && difficultyLow > 100) || (difficultyHigh !== null && difficultyHigh > 100) ? "难度值范围必须在 0–100 之间" : difficultyLow !== null && difficultyHigh !== null && difficultyLow > difficultyHigh ? "最低难度不能大于最高难度" : "";
  const dateError = lastAttemptFrom && lastAttemptTo && lastAttemptFrom > lastAttemptTo ? "开始日期不能晚于结束日期" : "";
  const requestedRandomCount = Math.floor(Number(customRandomCount));
  const customRandomError = mode === "randomCustom" && (!Number.isFinite(requestedRandomCount) || requestedRandomCount < 1 || requestedRandomCount > dataset.questions.length) ? `请输入 1–${Math.max(1, dataset.questions.length)} 之间的题数` : "";
  const disabled = !bankIds.length || Boolean(customRandomError) || (mode === "tag" && !selectedTags.length) || (mode === "advanced" && (!types.length || Boolean(regexError) || Boolean(metricError) || Boolean(dateError)));

  return <>
    {!hideHeading && <div className="page-heading compact"><div><p className="eyebrow">自由安排练习</p><h1>选择练习模式</h1><p>进度筛选当前使用 {normalizedScope.type === "rolling" ? `近 ${normalizedScope.days} 天` : normalizedScope.type === "lifetime" ? "全部时间" : "当前复习轮次"}，正确率与总次数仍为终身统计。</p></div></div>}
    <section className="practice-setup-card">
      <div className="setup-bank"><span>练习题库（可单选或多选）</span><div className="scope-bank-list">{banks.map((bank) => <button type="button" key={bank.id} aria-pressed={bankIds.includes(bank.id)} className={bankIds.includes(bank.id) ? "selected" : ""} onClick={() => toggleBank(bank.id)}><i /> <span><strong>{bank.displayName || bank.name}</strong><small>{bank.questionCount} 题</small></span></button>)}</div></div>
      <div className="mode-grid">{baseModes.map(({ id, title, detail, icon: Icon }) => <button type="button" key={id} className={mode === id ? "active" : ""} onClick={() => setMode(id)}><Icon size={20} /><strong>{id === "random30" ? `随机 ${groupSize} 题` : title}</strong><small>{id === "random30" ? `${detail} ${groupSize} 题` : detail}</small></button>)}</div>
      {rounds.filter((round) => round.status === "active").length > 0 && <label>绑定复习轮次（可选；一次练习最多绑定一轮）<AppSelect ariaLabel="复习轮次" value={reviewRoundId || "none"} onValueChange={(value) => { const round = rounds.find((candidate) => candidate.id === value && candidate.status === "active"); setReviewRoundId(round?.id ?? ""); if (round) { setBankIds([...round.bankIds]); onBankChange([...round.bankIds]); } }} options={[{ value: "none", label: "普通练习，不推进轮次" }, ...rounds.filter((round) => round.status === "active").map((round) => ({ value: round.id, label: `${round.name}（动态题库成员）` }))]} /></label>}
      {mode === "randomCustom" && <div className="custom-random-count"><div><strong>本次随机抽取题数</strong><small>只对即将开始的这次练习生效。</small></div><label>题数<input aria-label="本次随机题数" type="number" min="1" max={Math.max(1, dataset.questions.length)} step="1" inputMode="numeric" value={customRandomCount} onChange={(event) => setCustomRandomCount(event.target.value)} /></label>{customRandomError && <p className="filter-error">{customRandomError}</p>}</div>}
      {(mode === "tag" || mode === "advanced") && <div className="filter-section"><div className="filter-title"><Tags size={17} /><strong>用户标签</strong><small>{selectedTags.length ? `已选 ${selectedTags.length} 个` : mode === "tag" ? "请选择标签" : "不限制标签"}</small></div>{tags.length ? <><div className="chip-list">{tags.map((tag) => <button type="button" key={tag} className={selectedTags.includes(tag) ? "selected" : ""} onClick={() => toggleTag(tag)}>{tag}</button>)}</div>{selectedTags.length > 1 && <div className="tag-match-control"><span>多个标签：</span><button type="button" className={tagMatch === "any" ? "selected" : ""} onClick={() => setTagMatch("any")}>符合任意一个</button><button type="button" className={tagMatch === "all" ? "selected" : ""} onClick={() => setTagMatch("all")}>同时符合全部</button></div>}</> : <p className="filter-empty">当前题库还没有用户标签。</p>}</div>}
      {mode === "advanced" && <><ProgressScopeSetting value={effectiveScope} onChange={setAdvancedScope} /><div className="advanced-query-grid"><div className="filter-section keyword-filter"><div className="filter-title"><Search size={17} /><strong>关键词匹配</strong><small>题干、选项和图片说明</small></div><div className="query-row"><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={keywordMode === "regex" ? "例如：弧垂|导线|杆塔" : "输入要查找的文字"} /><AppSelect ariaLabel="关键词方式" value={keywordMode} onValueChange={(value) => setKeywordMode(value as V7PracticeFilter["keywordMode"])} options={[{ value: "plain", label: "包含关键词" }, { value: "regex", label: "正则表达式" }]} /></div>{regexError && <p className="filter-error">{regexError}</p>}</div><div className="filter-section history-filter"><div className="filter-title"><History size={17} /><strong>终身统计筛选</strong><small>正确率/总次数不受进度口径影响</small></div><div className="metric-grid"><label>总作答最少<input type="number" min="0" value={totalAttemptsMin} onChange={(event) => setTotalAttemptsMin(event.target.value)} /></label><label>总作答最多<input type="number" min="0" value={totalAttemptsMax} onChange={(event) => setTotalAttemptsMax(event.target.value)} /></label><label>错误次数最少<input type="number" min="0" value={wrongAttemptsMin} onChange={(event) => setWrongAttemptsMin(event.target.value)} /></label><label>错误次数最多<input type="number" min="0" value={wrongAttemptsMax} onChange={(event) => setWrongAttemptsMax(event.target.value)} /></label><label>最低难度<input type="number" min="0" max="100" value={difficultyMin} onChange={(event) => setDifficultyMin(event.target.value)} /></label><label>最高难度<input type="number" min="0" max="100" value={difficultyMax} onChange={(event) => setDifficultyMax(event.target.value)} /></label></div>{metricError && <p className="filter-error">{metricError}</p>}<div className="date-range"><label>最近作答从<input type="date" value={lastAttemptFrom} onChange={(event) => setLastAttemptFrom(event.target.value)} /></label><label>到<input type="date" value={lastAttemptTo} onChange={(event) => setLastAttemptTo(event.target.value)} /></label></div>{dateError && <p className="filter-error">{dateError}</p>}</div><div className="filter-section"><div className="filter-title"><strong>高级选项</strong><small>可覆盖临时排序和状态</small></div><div className="advanced-choice-row"><label>题型{questionTypes.map((type) => <button type="button" key={type} className={types.includes(type) ? "selected" : ""} onClick={() => toggleType(type)}>{type}</button>)}</label><label>状态<AppSelect ariaLabel="状态" value={status} onValueChange={(value) => setStatus(value as V7PracticeFilter["status"])} options={[{ value: "all", label: "全部" }, { value: "unanswered", label: "进度口径未做" }, { value: "wrong", label: "错题" }, { value: "favorite", label: "收藏" }]} /></label><label>排序<AppSelect ariaLabel="排序" value={order} onValueChange={(value) => setOrder(value as V7PracticeFilter["order"])} options={[{ value: "sequential", label: "题库顺序" }, { value: "random", label: "随机" }, { value: "difficulty", label: "难度优先" }]} /></label><label>最多题数<input type="number" min="1" value={limit ?? ""} onChange={(event) => setLimit(event.target.value ? Math.max(1, Math.floor(Number(event.target.value))) : null)} /></label></div></div></div></>}
      <div className="setup-footer"><ScopeSummaryChips total={dataset.questions.length} done={doneCount} scopeLabel={effectiveScopeLabel} totalLabel="可用" /><button type="button" className="primary" disabled={disabled} onClick={start}>开始练习</button></div>
    </section>
  </>;
}
