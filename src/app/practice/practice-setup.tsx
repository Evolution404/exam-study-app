/* eslint-disable jsx-a11y/label-has-associated-control */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { CalendarDays, ChevronDown, ChevronUp, Gauge, History, ListOrdered, RotateCcw, Search, Shuffle, SlidersHorizontal, Star, Tags } from "lucide-react";
import { readPracticeSetupDatasetV7 } from "@/lib/db/practice-setup-read-v7";
import { statsNeedWrongReview } from "@/lib/practice/practice-metrics";
import { buildScopedQuestionStats, isQuestionDoneInScope, normalizeProgressScope, progressScopeKey, scopedStatsToAttemptStats, type ProgressScope } from "@/lib/practice/progress-scope";
import { AppSelect } from "@/app/ui/app-select";
import { ProgressScopeSetting } from "@/app/practice/progress-scope-setting";
import { ScopeSummaryChips } from "@/app/ui/scope-summary-chips";
import { TagMultiSelect } from "@/app/ui/tag-multi-select";
import type { BankV7, QuestionTypeV7, ReviewRound } from "@/lib/db/v7-types";
import {
  assemblePracticeFilter,
  countAdvancedPracticeFilters,
  PRACTICE_QUESTION_TYPES,
  validatePracticeSetup,
  type PracticeAmountChoice,
  type PracticeCombo,
  type PracticeSetupFormState,
  type V7PracticeFilter,
} from "@/lib/practice/practice-setup-model";
export type { V7PracticeFilter, V7PracticeMode } from "@/lib/practice/practice-setup-model";

// 快捷卡片的两种行为：start=点卡片立即以纯预设开始（不读取下方自定义区）；
// configure=把预设填进下方自定义组合（或展开对应折叠区），由用户确认后开始。
type PresetCard =
  | { id: string; title: string; detail: string; icon: typeof Shuffle; kind: "start"; combo: PracticeCombo }
  | { id: string; title: string; detail: string; icon: typeof Shuffle; kind: "configure" };

const presetCards: PresetCard[] = [
  { id: "random30", title: "随机一组", detail: "从已选题库随机抽取", icon: Shuffle, kind: "start", combo: { status: "all", order: "random", amount: "default" } },
  { id: "randomCustom", title: "随机指定题数", detail: "本次输入题数，不修改全局配置", icon: Shuffle, kind: "configure" },
  { id: "sequential", title: "全量顺序练习", detail: "按题库顺序练完全部题目", icon: ListOrdered, kind: "start", combo: { status: "all", order: "sequential", amount: "all" } },
  { id: "randomAll", title: "全量随机练习", detail: "全部题目随机排列", icon: Shuffle, kind: "start", combo: { status: "all", order: "random", amount: "all" } },
  { id: "wrong", title: "练习错题", detail: "集中练习当前口径下的错题", icon: RotateCcw, kind: "start", combo: { status: "wrong", order: "sequential", amount: "all" } },
  { id: "favorite", title: "练习收藏题", detail: "只练习自己收藏的题目", icon: Star, kind: "start", combo: { status: "favorite", order: "sequential", amount: "all" } },
  { id: "difficult", title: "优先复习", detail: "综合个人难度与距上次作答时间排序", icon: Gauge, kind: "start", combo: { status: "all", order: "difficulty", amount: "all" } },
  { id: "tag", title: "标签模式", detail: "按知识标签练习", icon: Tags, kind: "configure" },
];

const statusOptions: Array<{ id: V7PracticeFilter["status"]; label: string }> = [
  { id: "all", label: "全部" },
  { id: "unanswered", label: "未做过" },
  { id: "wrong", label: "错题" },
  { id: "favorite", label: "收藏" },
];

const orderOptions: Array<{ id: V7PracticeFilter["order"]; label: string }> = [
  { id: "sequential", label: "题库顺序" },
  { id: "random", label: "随机" },
  { id: "difficulty", label: "复习优先" },
];

const questionTypes: QuestionTypeV7[] = PRACTICE_QUESTION_TYPES;

export function PracticeSetupView({ banks, currentBankIds, onBankChange, onStart, hideHeading = false, groupSize = 30, defaultOrder = "sequential", progressScope = { type: "rolling", days: 90 }, wrongRemovalStreak = 3, rounds = [] }: {
  banks: BankV7[];
  currentBankIds: string[];
  onBankChange: (bankIds: string[]) => void;
  onStart: (filter: V7PracticeFilter) => void;
  hideHeading?: boolean;
  groupSize?: number;
  defaultOrder?: V7PracticeFilter["order"];
  progressScope?: ProgressScope;
  wrongRemovalStreak?: number;
  rounds?: readonly ReviewRound[];
}) {
  const [bankIds, setBankIds] = useState(currentBankIds);
  const [types, setTypes] = useState<QuestionTypeV7[]>(questionTypes);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagMatch, setTagMatch] = useState<"any" | "all">("any");
  const [status, setStatus] = useState<V7PracticeFilter["status"]>("all");
  const [order, setOrder] = useState<V7PracticeFilter["order"]>(defaultOrder);
  const [amountChoice, setAmountChoice] = useState<PracticeAmountChoice>("all");
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tagSectionOpen, setTagSectionOpen] = useState(false);
  const customCountInputRef = useRef<HTMLInputElement>(null);
  const tagSectionRef = useRef<HTMLDivElement>(null);
  const bankKey = bankIds.join("|");
  const dataset = useLiveQuery(() => readPracticeSetupDatasetV7(bankIds), [bankKey])
    ?? { questions: [], stats: [], roundsProgress: [], attempts: [] };
  const tags = useMemo(() => [...new Set(dataset.questions.flatMap((question) => question.tags))].sort((a, b) => a.localeCompare(b, "zh-CN")), [dataset.questions]);
  const normalizedScope = normalizeProgressScope(progressScope);
  const effectiveScope = normalizeProgressScope(advancedScope ?? normalizedScope);
  const effectiveScopeLabel = effectiveScope.type === "rolling" ? `近 ${effectiveScope.days} 天`
    : effectiveScope.type === "lifetime" ? "全部时间"
      : rounds.find((round) => round.id === effectiveScope.roundId)?.name ?? "当前复习轮次";
  const [referenceTime] = useState(Date.now);
  const doneCount = useMemo(() => dataset.questions.filter((question) => isQuestionDoneInScope(question.id, effectiveScope, dataset.stats, dataset.roundsProgress, referenceTime)).length, [dataset.questions, dataset.stats, dataset.roundsProgress, effectiveScope, referenceTime]);
  // 错题/收藏卡的实时计数：错题与开始练习同一口径（进度口径 scoped + 连对移出阈值）。
  const wrongCardCount = useMemo(() => {
    const scoped = buildScopedQuestionStats(dataset.questions.map((question) => question.id), effectiveScope, dataset.attempts, dataset.roundsProgress, referenceTime);
    let count = 0;
    scoped.forEach((stats) => { if (statsNeedWrongReview(scopedStatsToAttemptStats(stats), wrongRemovalStreak)) count += 1; });
    return count;
  }, [dataset.questions, dataset.attempts, dataset.roundsProgress, effectiveScope, referenceTime, wrongRemovalStreak]);
  const favoriteCardCount = useMemo(() => dataset.questions.filter((question) => question.favorite).length, [dataset.questions]);

  // 题量切到「自定义题数」时（无论是点卡片还是点题量分段）聚焦同一个题数输入框。
  useEffect(() => {
    if (amountChoice === "custom") customCountInputRef.current?.focus();
  }, [amountChoice]);

  function toggleType(type: QuestionTypeV7) { setTypes(types.includes(type) ? types.filter((item) => item !== type) : [...types, type]); }
  function toggleBank(bankId: string) {
    const next = bankIds.includes(bankId) ? bankIds.filter((id) => id !== bankId) : [...bankIds, bankId];
    setBankIds(next);
    if (reviewRoundId) setReviewRoundId("");
    onBankChange(next);
  }

  function activateCard(card: PresetCard) {
    if (card.kind === "start") {
      onStart(assembleFilter(card.combo, { quick: true }));
      return;
    }
    if (card.id === "randomCustom") {
      setStatus("all");
      setOrder("random");
      setAmountChoice("custom");
      return;
    }
    setTagSectionOpen(true);
    requestAnimationFrame(() => tagSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }

  const requestedRandomCount = Math.floor(Number(customRandomCount));
  const scopeOverridden = advancedScope !== null && progressScopeKey(advancedScope) !== progressScopeKey(normalizedScope);
  const setupState: PracticeSetupFormState = {
    bankIds, types, selectedTags, tagMatch, status, order, amountChoice, requestedRandomCount,
    keyword, keywordMode, totalAttemptsMin, totalAttemptsMax, wrongAttemptsMin, wrongAttemptsMax,
    difficultyMin, difficultyMax, lastAttemptFrom, lastAttemptTo, reviewRoundId,
    effectiveScope, normalizedScope, scopeOverridden,
  };
  const advancedFilterCount = countAdvancedPracticeFilters(setupState);

  // filter 组装的唯一出口：quick 卡片不读取自定义区；组合路径使用 canonical pure model。
  function assembleFilter(combo: PracticeCombo | null, { quick = false } = {}): V7PracticeFilter {
    return assemblePracticeFilter(setupState, { combo, quick, groupSize });
  }

  function start() {
    onStart(assembleFilter(null, { quick: false }));
  }

  function resetAdvancedFilters() {
    setKeyword("");
    setKeywordMode("plain");
    setTotalAttemptsMin("");
    setTotalAttemptsMax("");
    setWrongAttemptsMin("");
    setWrongAttemptsMax("");
    setDifficultyMin("");
    setDifficultyMax("");
    setLastAttemptFrom("");
    setLastAttemptTo("");
    setAdvancedScope(null);
  }

  const { regexError, metricError, dateError, typeError, customRandomError, disabled } = validatePracticeSetup(setupState, dataset.questions.length);
  // 高级筛选折叠时错误输入仍参与校验（会禁用开始按钮），错误文案需镜像到 footer 上方，
  // 否则用户看不到禁用原因。题型已移到常驻区域，错误直接就地展示。
  const collapsedErrors = advancedOpen ? [] : [regexError, metricError, dateError].filter(Boolean);
  const amountOptions: Array<{ id: PracticeAmountChoice; label: string }> = [
    { id: "default", label: `${groupSize} 题` },
    { id: "custom", label: "自定义题数" },
    { id: "all", label: "全部题目" },
  ];

  return <>
    {!hideHeading && <div className="page-heading compact"><div><p className="eyebrow">自由安排练习</p><h1>选择练习方式</h1><p>进度筛选当前使用 {normalizedScope.type === "rolling" ? `近 ${normalizedScope.days} 天` : normalizedScope.type === "lifetime" ? "全部时间" : "当前复习轮次"}，正确率与总次数仍为终身统计。</p></div></div>}
    <section className="practice-setup-card">
      <div className="setup-bank"><span>练习题库（可单选或多选）</span><div className="scope-bank-list">{banks.map((bank) => <button type="button" key={bank.id} aria-pressed={bankIds.includes(bank.id)} className={bankIds.includes(bank.id) ? "selected" : ""} onClick={() => toggleBank(bank.id)}><i /> <span><strong>{bank.displayName || bank.name}</strong><small>{bank.questionCount} 题</small></span></button>)}</div></div>
      {rounds.filter((round) => round.status === "active").length > 0 && <label>绑定复习轮次（可选；一次练习最多绑定一轮）<AppSelect ariaLabel="复习轮次" value={reviewRoundId || "none"} onValueChange={(value) => { const round = rounds.find((candidate) => candidate.id === value && candidate.status === "active"); setReviewRoundId(round?.id ?? ""); if (round) { const nextBankIds = round.bankIds.filter((id) => banks.some((bank) => bank.id === id)); setBankIds(nextBankIds); onBankChange(nextBankIds); } }} options={[{ value: "none", label: "普通练习，不推进轮次" }, ...rounds.filter((round) => round.status === "active").map((round) => ({ value: round.id, label: `${round.name}（动态题库成员）` }))]} /></label>}
      <div className="quick-start-heading"><strong>快捷开始</strong><small>点卡片立即开始，不使用下方自定义组合</small></div>
      <div className="mode-grid">{presetCards.map((card) => {
        // 错题/收藏卡显示实时计数；错题为 0 时禁用（口径与开始练习完全一致）。
        const cardDetail = card.id === "random30" ? `${card.detail} ${groupSize} 题`
          : card.id === "wrong" ? `当前口径下 ${wrongCardCount} 道错题`
          : card.id === "favorite" ? `共 ${favoriteCardCount} 道收藏题`
          : card.kind === "configure" ? `${card.detail}，先填充设置`
          : card.detail;
        const cardDisabled = card.kind === "start" && (!bankIds.length
          || (card.id === "wrong" && wrongCardCount === 0)
          || (card.id === "favorite" && favoriteCardCount === 0));
        return <button type="button" key={card.id} disabled={cardDisabled} onClick={() => activateCard(card)}><card.icon size={20} /><strong>{card.id === "random30" ? `随机 ${groupSize} 题` : card.title}</strong><small>{cardDetail}</small></button>;
      })}</div>
      <div className="quick-start-heading"><strong>自定义组合</strong><small>出题范围 × 顺序 × 题型 × 题量，自由组合后开始</small></div>
      <div className="custom-combo">
        <div className="practice-segment-group">
          <span>出题范围</span>
          <div className="practice-segment-row" role="group" aria-label="出题范围">{statusOptions.map((option) => <button type="button" key={option.id} aria-pressed={status === option.id} className={status === option.id ? "selected" : ""} onClick={() => setStatus(option.id)}>{option.label}</button>)}</div>
        </div>
        <div className="practice-segment-group">
          <span>顺序</span>
          <div className="practice-segment-row" role="group" aria-label="顺序">{orderOptions.map((option) => <button type="button" key={option.id} aria-pressed={order === option.id} className={order === option.id ? "selected" : ""} onClick={() => setOrder(option.id)}>{option.label}</button>)}</div>
        </div>
        <div className="practice-segment-group">
          <span>题型</span>
          <div className="practice-segment-row type-choice-row" role="group" aria-label="题型">{questionTypes.map((type) => <button type="button" key={type} aria-pressed={types.includes(type)} className={types.includes(type) ? "selected" : ""} onClick={() => toggleType(type)}>{type}</button>)}</div>
          {!types.length && <p className="filter-error">{typeError}</p>}
        </div>
        <div className="practice-segment-group">
          <span>题量</span>
          <div className="practice-segment-row" role="group" aria-label="题量">{amountOptions.map((option) => <button type="button" key={option.id} aria-pressed={amountChoice === option.id} className={amountChoice === option.id ? "selected" : ""} onClick={() => setAmountChoice(option.id)}>{option.label}</button>)}</div>
        </div>
        {amountChoice === "custom" && <div className="custom-random-count"><div><strong>本次随机抽取题数</strong><small>只对即将开始的这次练习生效，不修改全局配置。</small></div><label>题数<input ref={customCountInputRef} aria-label="本次随机题数" type="number" min="1" max={Math.max(1, dataset.questions.length)} step="1" inputMode="numeric" value={customRandomCount} onChange={(event) => setCustomRandomCount(event.target.value)} /></label>{customRandomError && <p className="filter-error">{customRandomError}</p>}</div>}

        <button type="button" className="advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(!advancedOpen)}>
          <SlidersHorizontal size={16} />
          <strong>高级筛选</strong>
          <small>{advancedFilterCount ? `已设置 ${advancedFilterCount} 项` : "关键词、统计、最近作答、进度口径"}</small>
          {advancedOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>

        {advancedOpen && <div className="practice-advanced-panel">
          <div className="practice-advanced-head">
            <div><strong>精细筛选</strong><small>留空即不限，只影响这次练习。</small></div>
            <button type="button" className="practice-advanced-reset" disabled={!advancedFilterCount} onClick={resetAdvancedFilters}><RotateCcw size={14} />重置</button>
          </div>

          <div className="practice-advanced-grid">
            <section className="advanced-compact-card">
              <header><Search size={15} /><span><strong>关键词</strong><small>题干、选项、图片说明</small></span></header>
              <div className="advanced-keyword-row">
                <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={keywordMode === "regex" ? "例如：弧垂|导线|杆塔" : "输入关键词"} />
                <AppSelect className="advanced-keyword-mode" ariaLabel="关键词方式" value={keywordMode} onValueChange={(value) => setKeywordMode(value as V7PracticeFilter["keywordMode"])} options={[{ value: "plain", label: "包含关键词" }, { value: "regex", label: "正则表达式" }]} />
              </div>
              {regexError && <p className="filter-error">{regexError}</p>}
            </section>

            <section className="advanced-compact-card">
              <header><History size={15} /><span><strong>终身统计</strong><small>留空表示不限</small></span></header>
              <div className="advanced-range-list">
                <label><span>总作答次数</span><div className="advanced-range-pair"><input aria-label="总作答最少" type="number" min="0" placeholder="最少" value={totalAttemptsMin} onChange={(event) => setTotalAttemptsMin(event.target.value)} /><i>—</i><input aria-label="总作答最多" type="number" min="0" placeholder="最多" value={totalAttemptsMax} onChange={(event) => setTotalAttemptsMax(event.target.value)} /></div></label>
                <label><span>错误次数</span><div className="advanced-range-pair"><input aria-label="错误次数最少" type="number" min="0" placeholder="最少" value={wrongAttemptsMin} onChange={(event) => setWrongAttemptsMin(event.target.value)} /><i>—</i><input aria-label="错误次数最多" type="number" min="0" placeholder="最多" value={wrongAttemptsMax} onChange={(event) => setWrongAttemptsMax(event.target.value)} /></div></label>
                <label><span>个人难度</span><div className="advanced-range-pair"><input aria-label="最低难度" type="number" min="0" max="100" placeholder="最低" value={difficultyMin} onChange={(event) => setDifficultyMin(event.target.value)} /><i>—</i><input aria-label="最高难度" type="number" min="0" max="100" placeholder="最高" value={difficultyMax} onChange={(event) => setDifficultyMax(event.target.value)} /></div></label>
              </div>
              {metricError && <p className="filter-error">{metricError}</p>}
            </section>

            <section className="advanced-compact-card advanced-date-card">
              <header><CalendarDays size={15} /><span><strong>最近作答时间</strong><small>按最后一次作答日期筛选</small></span></header>
              <div className="date-range"><div className="advanced-date-row">
                <label><span>从</span><input aria-label="最近作答从" type="date" value={lastAttemptFrom} onChange={(event) => setLastAttemptFrom(event.target.value)} /></label>
                <label><span>到</span><input aria-label="到" type="date" value={lastAttemptTo} onChange={(event) => setLastAttemptTo(event.target.value)} /></label>
              </div></div>
              {dateError && <p className="filter-error">{dateError}</p>}
            </section>
          </div>

          <div className="practice-scope-compact"><ProgressScopeSetting value={effectiveScope} onChange={setAdvancedScope} /></div>
        </div>}

        <button type="button" className="advanced-toggle" aria-expanded={tagSectionOpen} onClick={() => setTagSectionOpen(!tagSectionOpen)}><Tags size={16} /> <strong>标签</strong> <small>{selectedTags.length ? `已选 ${selectedTags.length} 个` : tags.length ? "不限制标签" : "当前题库还没有用户标签"}</small> {tagSectionOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>
        {tagSectionOpen && <div ref={tagSectionRef} className="filter-section"><div className="filter-title"><Tags size={17} /><strong>用户标签</strong><small>{selectedTags.length ? `已选 ${selectedTags.length} 个` : "请选择标签"}</small></div><TagMultiSelect tags={tags} selected={selectedTags} onChange={setSelectedTags} matchMode={tagMatch} onMatchModeChange={setTagMatch} ariaLabel="搜索练习标签" emptyLabel="当前题库还没有用户标签" /></div>}
      </div>
      {collapsedErrors.length > 0 && <div className="setup-error-summary">{collapsedErrors.map((message) => <p className="filter-error" key={message}>{message}</p>)}</div>}
      <div className="setup-footer"><ScopeSummaryChips total={dataset.questions.length} done={doneCount} scopeLabel={effectiveScopeLabel} totalLabel="可用" /><button type="button" className="primary" disabled={disabled} onClick={start}>开始练习</button></div>
    </section>
  </>;
}
