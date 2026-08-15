"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BookOpen, Brain, Check, CheckCheck, ChevronLeft, ChevronRight, ClipboardCheck, Cloud, Copy, BadgeInfo, CircleHelp, FileUp, Grid3X3, ListFilter, Monitor, Moon, NotebookPen, Pencil, Play, RefreshCw, Settings2, Star, Sun, Target, X } from "lucide-react";
import { archiveReviewRoundV6, completeReviewRoundV6, createReviewRoundV6, dbV6, getImageCacheSizeV6, updateReviewRoundV6 } from "@/lib/db/db-v6";
import { loadGitHubSettings, loadGitHubToken } from "@/lib/sync/github-credentials";
import { clearImageCache, downloadAllImageAssets, getImageCacheStats } from "@/lib/sync/github-sync";
import { difficultyLabel, difficultyTone } from "@/lib/practice/practice-metrics";
import { SharedQuestionEditor, loadImageAssetV6 } from "@/app/bank/question-editor";
import { NoteMarkdown } from "@/app/ui/note-markdown";
import { ContentBlockRenderer } from "@/app/bank/content-block-renderer";
import { ProgressScopeSetting } from "@/app/practice/progress-scope-setting";
import { ReviewRoundManager } from "@/app/practice/review-round-manager";
import { ShortcutSetting } from "@/app/ui/shortcut-setting";
import { ModalPortal } from "@/app/ui/modal-portal";
import { AppSelect } from "@/app/ui/app-select";
import { ScopeSummaryChips } from "@/app/ui/scope-summary-chips";
import { Hint } from "@/app/ui/hint";
import { formatKeyboardShortcut, resolveKeyboardShortcut } from "@/lib/practice/keyboard-shortcuts";
import { shouldSubmitOnChoice } from "@/lib/practice/answer-submission";
import { isCalculationAnswerCorrect } from "@/lib/question/question-utils";
import type { BankV6, ReviewRound } from "@/lib/db/v6-types";
import { questionOverviewProgress } from "@/lib/question/question-overview";
import { SyncView, TYPE_ORDER, answerText, displayedAnswer, formatBuildTimestamp, formatDate, playAnswerFeedback, recordPracticeAnswer, saveNote, summarizeV6AttemptStats, updateServiceWorkerWithinTimeout, type PracticeAnswerState, type PracticePreferences, type PracticeRun, type Question, type QuestionType } from "./helpers";

export function PullToRefresh() {
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const currentDistance = useRef(0);

  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>(".workspace");
    if (!scroller) return;
    const reset = () => {
      start.current = null;
      currentDistance.current = 0;
      setPulling(false);
      setDistance(0);
    };
    const onStart = (event: TouchEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (refreshing || scroller.scrollTop > 0 || event.touches.length !== 1 || target?.closest("button, a, input, textarea, select, [role='dialog'], [data-no-pull-refresh], .search-results, .editor-backdrop, .overview-backdrop, .search-detail-backdrop, .simple-dialog-backdrop")) return;
      start.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    };
    const onMove = (event: TouchEvent) => {
      if (!start.current || scroller.scrollTop > 0) return;
      const dx = event.touches[0].clientX - start.current.x;
      const dy = event.touches[0].clientY - start.current.y;
      if (dy <= 0 || Math.abs(dx) >= dy) {
        if (Math.abs(dx) > 10 || dy < -4) reset();
        return;
      }
      if (dy < 12) return;
      event.preventDefault();
      const next = Math.min(104, (dy - 12) * .42);
      currentDistance.current = next;
      setPulling(true);
      setDistance(next);
    };
    const onEnd = async () => {
      start.current = null;
      setPulling(false);
      if (currentDistance.current < 64 || refreshing) {
        reset();
        return;
      }
      setRefreshing(true);
      setDistance(52);
      try {
        // A service-worker update is best-effort. Never make a pull gesture
        // wait forever when a browser has a stalled update request.
        await updateServiceWorkerWithinTimeout();
      } finally {
        reset();
        setRefreshing(false);
        window.location.reload();
      }
    };
    scroller.addEventListener("touchstart", onStart, { passive: true });
    scroller.addEventListener("touchmove", onMove, { passive: false });
    scroller.addEventListener("touchend", onEnd, { passive: true });
    scroller.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      scroller.removeEventListener("touchstart", onStart);
      scroller.removeEventListener("touchmove", onMove);
      scroller.removeEventListener("touchend", onEnd);
      scroller.removeEventListener("touchcancel", reset);
    };
  }, [refreshing]);

  return <div role="status" aria-live="polite" className={`pull-refresh ${refreshing ? "refreshing" : ""} ${pulling ? "pulling" : ""} ${distance >= 64 ? "ready" : ""}`} style={{ transform: `translate(-50%, ${distance - 54}px)`, opacity: distance ? 1 : 0 }}><RefreshCw size={17} /><span>{refreshing ? "正在加载最新版…" : distance >= 64 ? "松开刷新" : "下拉刷新"}</span></div>;
}

export function Dashboard({ groupSize, dailyGoalCount, dailyGoalAccuracy, scopeProgress, scopeLabel, scopeStats, stats, banks, latestPracticeRun, selectedBankIds, onBankToggle, onImport, onStart, onResume, onDiscardResume, onMoreModes }: {
  groupSize: number;
  dailyGoalCount: number;
  dailyGoalAccuracy: number;
  scopeProgress: { completed: number; total: number };
  scopeLabel: string;
  scopeStats: { questions: number; attempts: number; correct: number; notes: number; bankCount: number; last?: string };
  stats: { questions: number; attempts: number; correct: number; todayAttempts: number; todayCorrect: number; pending: number; notes: number; last?: string };
  banks: Array<{ id: string; name: string; displayName?: string; questionCount: number }>;
  latestPracticeRun?: PracticeRun;
  selectedBankIds: string[];
  onBankToggle: (bankId: string) => void;
  onImport: () => void; onStart: () => void; onResume: (runId: string) => void; onDiscardResume: (runId: string) => void; onMoreModes: () => void;
}) {
  const scopeAccuracy = scopeStats.attempts ? Math.round(scopeStats.correct / scopeStats.attempts * 100) : 0;
  const todayAccuracy = stats.todayAttempts ? Math.round(stats.todayCorrect / stats.todayAttempts * 100) : 0;
  const countProgress = Math.min(100, Math.round(stats.todayAttempts / dailyGoalCount * 100));
  const selectedBanks = banks.filter((bank) => selectedBankIds.includes(bank.id));
  const selectedQuestions = selectedBanks.reduce((total, bank) => total + bank.questionCount, 0);
  const answeredInRun = latestPracticeRun ? Object.values(latestPracticeRun.answers).filter((answer) => answer.submitted).length : 0;
  const resumeProgress = latestPracticeRun?.questionIds.length ? Math.round(answeredInRun / latestPracticeRun.questionIds.length * 100) : 0;
  return <>
    <div className="home-heading"><h1>今日练习</h1><p>选择题库开始练习，或继续上次进度。</p>{selectedBanks.length > 0 && <div className="home-scope-summary"><ScopeSummaryChips total={scopeProgress.total} done={scopeProgress.completed} scopeLabel={scopeLabel} /></div>}</div>
    {latestPracticeRun && <section className="resume-card"><span className="resume-mark"><Play size={21} /></span><div className="resume-copy"><small>继续上次练习</small><strong>{latestPracticeRun.bankName}</strong><p>{latestPracticeRun.modeLabel}</p></div><div className="resume-progress"><div><span><b>{answeredInRun}</b> / {latestPracticeRun.questionIds.length} 已作答</span><strong>{resumeProgress}%</strong></div><i aria-label={`练习进度 ${resumeProgress}%`}><b style={{ width: `${resumeProgress}%` }} /></i></div><div className="resume-card-actions"><button className="resume-continue" onClick={() => onResume(latestPracticeRun.id)}>继续练习<ChevronRight size={17} /></button><Hint label="放弃上次练习"><button className="resume-discard" aria-label="放弃上次练习" onClick={() => onDiscardResume(latestPracticeRun.id)}><X size={16} /></button></Hint></div></section>}
    {banks.length ? <section className="home-bank-scope"><div className="scope-heading"><div><span className="section-kicker">当前题库范围</span><h2>选择一个或多个题库</h2></div><small>可以暂不选择</small></div><div className={`home-bank-grid${banks.length === 1 ? " single-bank" : ""}`}>{banks.map((bank) => { const selected = selectedBankIds.includes(bank.id); return <button key={bank.id} aria-pressed={selected} className={selected ? "selected" : ""} onClick={() => onBankToggle(bank.id)}><span className="scope-check">{selected && <Check size={14} />}</span><div><strong>{bank.displayName || bank.name}</strong><small>{bank.questionCount.toLocaleString()} 题</small></div></button>; })}</div><div className="scope-footer"><p>{selectedBanks.length ? <>已选择 <strong>{selectedBanks.length}</strong> 个题库，共 <strong>{selectedQuestions.toLocaleString()}</strong> 题</> : "尚未选择练习题库，可以先查看题库或练习配置。"}</p><button className="primary" disabled={!selectedBankIds.length} onClick={onStart}><Brain size={18} />开始随机 {groupSize} 题</button></div></section> : <EmptyImport onImport={onImport} />}
    <section className="home-feature-grid">
      <article className="daily-practice"><div><span className="section-kicker">今日推荐</span><h2>来一组 {groupSize} 题</h2><p>{selectedBankIds.length ? "从已选题库随机抽题，再按单选、多选、判断、计算分组。" : "请先选择题库，或进入更多练习模式选择题库。"}</p><div><button disabled={!selectedBankIds.length} onClick={onStart}>开始这一组<ChevronRight size={17} /></button><button className="feature-secondary" onClick={onMoreModes}><ListFilter size={16} />更多练习模式</button></div></div><span className="daily-number"><strong>{groupSize}</strong><small>题</small></span></article>
      <article className="memory-card daily-goal-card"><span>今日目标</span><blockquote>{stats.todayAttempts} / {dailyGoalCount} 题</blockquote><div className="daily-goal-progress"><i style={{ width: `${countProgress}%` }} /></div><small>今日正确率 {todayAccuracy}% · 目标 {dailyGoalAccuracy}%</small>
        <p className={stats.todayAttempts >= dailyGoalCount && todayAccuracy >= dailyGoalAccuracy ? "achieved" : ""}>{stats.todayAttempts >= dailyGoalCount && todayAccuracy >= dailyGoalAccuracy ? "今日目标已达成" : stats.todayAttempts < dailyGoalCount ? `还差 ${dailyGoalCount - stats.todayAttempts} 题` : `正确率还差 ${Math.max(0, dailyGoalAccuracy - todayAccuracy)}%`}</p>
      </article>
    </section>
    <section className="stat-grid">
      <Stat icon={<BookOpen />} label="范围题目" value={scopeStats.questions.toLocaleString()} foot={`${scopeStats.bankCount} 个题库 · ${scopeLabel}`} />
      <Stat icon={<Target />} label={`作答（${scopeLabel}）`} value={scopeStats.attempts.toLocaleString()} foot={`最近：${formatDate(scopeStats.last)}`} />
      <Stat icon={<Check />} label={`正确率（${scopeLabel}）`} value={`${scopeAccuracy}%`} foot={scopeStats.attempts ? `${scopeStats.correct} 次答对` : "当前范围尚未作答"} />
      <Stat icon={<NotebookPen />} label="个人解析（当前题库范围）" value={scopeStats.notes.toLocaleString()} foot="不受时间范围影响" />
    </section>
    <section className="section-block"><div className="section-title"><div><span className="section-kicker">题库管理</span><h2>继续扩充你的练习范围</h2></div><button className="text-button" onClick={onImport}><FileUp size={16} />导入题库</button></div></section>
  </>;
}

export function Stat({ icon, label, value, foot }: { icon: React.ReactNode; label: string; value: string; foot: string }) {
  return <article className="stat-card"><span className="stat-icon">{icon}</span><span>{label}</span><strong>{value}</strong><small>{foot}</small></article>;
}

export function EmptyImport({ onImport }: { onImport: () => void }) {
  return <button className="empty-import" onClick={onImport}><span><FileUp size={22} /></span><div><strong>导入题库</strong><small>支持 JSON / XLSX，数据只写入本机</small></div><ChevronRight size={18} /></button>;
}

export function PreferencesView({ preferences, rounds, banks, pendingSync, onNotice, onChange, onRestored }: { preferences: PracticePreferences; rounds: readonly ReviewRound[]; banks: readonly BankV6[]; pendingSync: number; onNotice: (message: string) => void; onChange: (value: PracticePreferences) => void; onRestored: (message: string) => void }) {
  const interactionItems: Array<{ key: "submitOnSelect" | "autoNextCorrect" | "showAnswerOnWrong" | "swipeNavigation" | "shuffleOptions" | "multiSelectAllAutoSubmit"; title: string; detail: string }> = [
    { key: "submitOnSelect", title: "选择后立即提交", detail: "默认开启，仅用于单选题和判断题；关闭后选择只会高亮，需要点击“确认答案”或按回车提交。" },
    { key: "autoNextCorrect", title: "答对后自动下一题", detail: "单选题和判断题选对后自动前进；多选题确认答案正确后自动前进。" },
    { key: "showAnswerOnWrong", title: "答错显示正确答案", detail: "立即标出错误选项和正确选项，方便当场纠正记忆。" },
    { key: "swipeNavigation", title: "左右滑动切换题目", detail: "向左滑进入下一题，向右滑返回上一题。" },
    { key: "shuffleOptions", title: "随机排列选项", detail: "仅随机单选题和多选题；判断题和计算题不受影响。" },
    { key: "multiSelectAllAutoSubmit", title: "多选题全选后自动确认", detail: "点击“全选”后立即提交答案；关闭后只选中全部选项，可继续取消选项再手动确认。" },
  ];
  const feedbackItems: Array<{ key: "feedbackSound" | "feedbackHaptics"; title: string; detail: string }> = [
    { key: "feedbackSound", title: "答题提示音", detail: "用轻提示音区分答对和答错；系统静音时可能不播放。" },
    { key: "feedbackHaptics", title: "答题振动反馈", detail: "vibrate" in navigator ? "支持振动的手机会在判题后给出轻触反馈。" : "iPhone/Safari 不支持振动，此选项仅在 Android 上生效。" },
  ];
  const toggleRow = (item: { key: keyof Pick<PracticePreferences, "submitOnSelect" | "autoNextCorrect" | "showAnswerOnWrong" | "swipeNavigation" | "shuffleOptions" | "multiSelectAllAutoSubmit" | "feedbackSound" | "feedbackHaptics" | "requireAllAnswered">; title: string; detail: string }) => <label aria-label={item.title} className="preference-row" key={item.key}><div><strong>{item.title}</strong><p>{item.detail}</p></div><input aria-label={item.title} type="checkbox" checked={Boolean(preferences[item.key])} onChange={(event) => onChange({ ...preferences, [item.key]: event.target.checked })} /><span className="toggle" aria-hidden="true" /></label>;
  return <><div className="page-heading compact"><div><p className="eyebrow">练习偏好</p><h1>答题配置</h1><p>设置只保存在当前浏览器，不会修改题库内容。</p></div></div><div className="preferences-view">
    <section className="preference-card"><div className="settings-title"><span><Moon /></span><div><h2>外观主题</h2><p>可以跟随手机或电脑的系统外观，也可以固定使用浅色或深色。</p></div></div>
      <ThemeSetting value={preferences.themeMode} onChange={(themeMode) => onChange({ ...preferences, themeMode })} />
    </section>
    <section className="preference-card"><div className="settings-title"><span><Settings2 /></span><div><h2>答题交互</h2><p>根据自己的背题节奏随时调整。</p></div></div>
      <div className="preference-list">
        <GroupSizeSetting value={preferences.groupSize} onChange={(groupSize) => onChange({ ...preferences, groupSize })} />
        {interactionItems.map(toggleRow)}
        <div className="mobile-question-transition"><PreferenceSelect title="切换题目方式" detail="“滑动”会像阅读页面一样平滑切入；“立即”直接显示目标题目。" value={preferences.questionTransition} onChange={(value) => onChange({ ...preferences, questionTransition: value as PracticePreferences["questionTransition"] })} options={[["instant", "立即"], ["slide", "滑动"]]} /></div>
        <PreferenceSelect title="自动下一题等待时间" detail="答对后留出查看反馈的时间；选择立即可最快连续刷题。" value={String(preferences.autoNextDelayMs)} onChange={(value) => onChange({ ...preferences, autoNextDelayMs: Number(value) as PracticePreferences["autoNextDelayMs"] })} options={[['0','立即'],['500','0.5 秒'],['1000','1 秒'],['2000','2 秒']]} />
      </div>
    </section>
    <div className="desktop-shortcut-settings"><ShortcutSetting value={preferences.keyboardShortcuts} onChange={(keyboardShortcuts) => onChange({ ...preferences, keyboardShortcuts })} /></div>
    <section className="preference-card"><div className="settings-title"><span><ListFilter /></span><div><h2>出题与复习</h2><p>控制抽题分布、默认顺序和错题复习节奏。</p></div></div><div className="preference-list">
      <ProgressScopeSetting value={preferences.progressScope} rounds={rounds} onChange={(progressScope) => onChange({ ...preferences, progressScope })} />
      <PreferenceSelect title="随机组题型分布" detail="均衡抽取会尽量平均包含单选、多选、判断、计算；不足的题型由其他题型补足。" value={preferences.randomTypeBalance} onChange={(value) => onChange({ ...preferences, randomTypeBalance: value as PracticePreferences["randomTypeBalance"] })} options={[['balanced','尽量均衡'],['natural','按题库自然比例']]} />
      <PreferenceSelect title="默认题目顺序" detail="进入练习中心和高级筛选时默认使用的题目顺序。" value={preferences.defaultOrder} onChange={(value) => onChange({ ...preferences, defaultOrder: value as PracticePreferences["defaultOrder"] })} options={[['sequential','题库顺序'],['random','随机打乱'],['difficulty','难题优先']]} />
      <PreferenceSelect title="答错后的复习方式" detail="立即重答会在当前题显示按钮；本组结束可在成绩页集中重练；留到下次进入错题练习。" value={preferences.wrongReappearance} onChange={(value) => onChange({ ...preferences, wrongReappearance: value as PracticePreferences["wrongReappearance"] })} options={[['immediate','立即重答'],['end','本组结束集中重练'],['next','留到下次错题练习']]} />
      <PreferenceSelect title="连续答对后移出错题" detail="题目答错或选择“不会”后进入错题；达到连续正确次数后自动移除。" value={String(preferences.wrongRemovalStreak)} onChange={(value) => onChange({ ...preferences, wrongRemovalStreak: Number(value) })} options={[['1','1 次'],['2','2 次'],['3','3 次'],['5','5 次']]} />
      <ToleranceSetting value={preferences.calculationTolerancePercent} onChange={(calculationTolerancePercent) => onChange({ ...preferences, calculationTolerancePercent })} />
      {toggleRow({ key: "requireAllAnswered", title: "必须答完才能结束", detail: "打开后点击查看结果会自动定位到第一道未答题，不允许带着空题结束。" })}
    </div></section>
    <ReviewRoundManager
      rounds={rounds}
      banks={banks}
      onCreate={async (name, bankIds) => { await createReviewRoundV6({ name, bankIds }); onNotice(`已创建复习轮次「${name}」`); }}
      onUpdate={async (roundId, name, bankIds) => { await updateReviewRoundV6(roundId, { name, bankIds }); onNotice("复习轮次已更新"); }}
      onComplete={async (roundId) => { await completeReviewRoundV6(roundId); onNotice("复习轮次已完成并保存最终快照"); }}
      onArchive={async (roundId) => { await archiveReviewRoundV6(roundId); onNotice("复习轮次已归档"); }}
    />
    <ImageCacheSetting onNotice={onNotice} />
    <section className="preference-card"><div className="settings-title"><span><Target /></span><div><h2>阅读、反馈与目标</h2><p>调整显示密度，设置每天的练习目标。</p></div></div><div className="preference-list">
      <PreferenceSelect title="答题字号" detail="只调整题干与选项的阅读字号，不影响题目内容。" value={preferences.fontSize} onChange={(value) => onChange({ ...preferences, fontSize: value as PracticePreferences["fontSize"] })} options={[['small','较小'],['standard','标准'],['large','较大'],['xlarge','特大']]} />
      <GoalSetting count={preferences.dailyGoalCount} accuracy={preferences.dailyGoalAccuracy} onChange={(dailyGoalCount, dailyGoalAccuracy) => onChange({ ...preferences, dailyGoalCount, dailyGoalAccuracy })} />
      {feedbackItems.map(toggleRow)}
    </div></section>
    <SyncAutomationSetting preferences={preferences} onChange={onChange} />
    <BuildVersionCard />
    <div className="mobile-sync-settings"><SyncView pending={pendingSync} onNotice={onNotice} onRestored={onRestored} /></div>
  </div></>;
}

export function ImageCacheSetting({ onNotice }: { onNotice: (message: string) => void }) {
  const cachedBytes = useLiveQuery(() => getImageCacheSizeV6(), []) ?? 0;
  const [busy, setBusy] = useState(false);
  const [assetCount, setAssetCount] = useState<number | undefined>();

  async function refreshStats() {
    try {
      const stats = await getImageCacheStats();
      if (stats && typeof stats === "object" && "cached" in stats) {
        const count = Number((stats as { cached?: unknown }).cached);
        if (Number.isFinite(count)) setAssetCount(count);
      }
    } catch { /* image cache stats are best-effort */ }
  }

  async function cacheAll() {
    if (busy) return;
    const settings = loadGitHubSettings();
    const token = loadGitHubToken();
    if (!settings.repo || !token) { onNotice("请先在同步页面配置 GitHub，才能缓存远程图片"); return; }
    setBusy(true);
    try {
      await downloadAllImageAssets(settings, token);
      await refreshStats();
      onNotice("图片缓存已更新");
    } catch (error) { onNotice(error instanceof Error ? error.message : "图片缓存失败"); }
    finally { setBusy(false); }
  }

  async function clearCache() {
    if (busy) return;
    setBusy(true);
    try {
      await clearImageCache();
      setAssetCount(0);
      onNotice("本机图片缓存已清理");
    } catch (error) { onNotice(error instanceof Error ? error.message : "清理图片缓存失败"); }
    finally { setBusy(false); }
  }

  return <section className="preference-card image-cache-setting"><div className="settings-title"><span><Cloud /></span><div><h2>图片缓存</h2><p>图片只保存在本机缓存，不会在题目中写入 URL。离线时仍可查看已缓存图片。</p></div></div><div className="image-cache-actions"><span>已缓存 {assetCount === undefined ? "—" : assetCount.toLocaleString()} 个文件 · {(cachedBytes / 1024 / 1024).toFixed(1)} MB</span><div className="image-cache-buttons"><button type="button" className="primary" disabled={busy} onClick={() => void cacheAll()}>{busy ? "处理中…" : "缓存全部图片"}</button><button type="button" className="danger-button" disabled={busy} onClick={() => void clearCache()}>清空缓存</button></div></div></section>;
}

export function SyncAutomationSetting({ preferences, onChange }: { preferences: PracticePreferences; onChange: (value: PracticePreferences) => void }) {
  return <section className="preference-card"><div className="settings-title"><span><Cloud /></span><div><h2>后台同步</h2><p>两项功能默认关闭，开启后使用 v7 变更集和热窗口增量同步。</p></div></div><div className="preference-list">
    <label className="preference-row"><div><strong>累计事件后自动同步</strong><p>本地待同步事件达到设定数量时，在后台完成拉取、合并和上传。</p></div><input aria-label="累计事件后自动同步" type="checkbox" checked={preferences.autoSyncEnabled} onChange={(event) => onChange({ ...preferences, autoSyncEnabled: event.target.checked })} /><span className="toggle" aria-hidden="true" /></label>
    {preferences.autoSyncEnabled && <NumberPreference title="自动同步阈值" detail="本地累计多少条待同步事件后开始同步，可填写 1–1000。" value={preferences.autoSyncEventThreshold} min={1} max={1000} unit="条" onChange={(autoSyncEventThreshold) => onChange({ ...preferences, autoSyncEventThreshold })} />}
    <label className="preference-row"><div><strong>定期拉取远程数据</strong><p>只下载并合并其他设备的新数据，不会主动上传当前设备的数据。</p></div><input aria-label="定期拉取远程数据" type="checkbox" checked={preferences.periodicPullEnabled} onChange={(event) => onChange({ ...preferences, periodicPullEnabled: event.target.checked })} /><span className="toggle" aria-hidden="true" /></label>
    {preferences.periodicPullEnabled && <NumberPreference title="远程拉取间隔" detail="最短 30 秒；页面保持打开时生效。" value={preferences.periodicPullSeconds} min={30} max={86400} unit="秒" onChange={(periodicPullSeconds) => onChange({ ...preferences, periodicPullSeconds })} />}
  </div></section>;
}

export function NumberPreference({ title, detail, value, min, max, unit, onChange }: { title: string; detail: string; value: number; min: number; max: number; unit: string; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const commit = () => {
    const next = Math.min(max, Math.max(min, Math.floor(Number(draft) || value)));
    setDraft(String(next));
    onChange(next);
  };
  return <label className="preference-row number-preference"><div><strong>{title}</strong><p>{detail}</p></div><span className="number-setting"><input aria-label={title} type="number" min={min} max={max} inputMode="numeric" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><em>{unit}</em></span></label>;
}

export function ThemeSetting({ value, onChange }: { value: PracticePreferences["themeMode"]; onChange: (value: PracticePreferences["themeMode"]) => void }) {
  const choices: Array<{ value: PracticePreferences["themeMode"]; label: string; detail: string; icon: React.ReactNode }> = [
    { value: "system", label: "跟随系统", detail: "随系统自动切换", icon: <Monitor size={19} /> },
    { value: "light", label: "浅色", detail: "始终使用浅色", icon: <Sun size={19} /> },
    { value: "dark", label: "深色", detail: "始终使用夜间模式", icon: <Moon size={19} /> },
  ];
  return <div className="theme-setting" role="radiogroup" aria-label="外观主题">{choices.map((choice) => <button type="button" role="radio" aria-checked={value === choice.value} className={value === choice.value ? "active" : ""} key={choice.value} onClick={() => onChange(choice.value)}><span>{choice.icon}</span><strong>{choice.label}</strong><small>{choice.detail}</small>{value === choice.value && <Check size={15} />}</button>)}</div>;
}

export function PreferenceSelect({ title, detail, value, options, onChange }: { title: string; detail: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  const selectId = `preference-select-${title}`;
  return <label htmlFor={selectId} className="preference-row select-preference"><div><strong>{title}</strong><p>{detail}</p></div><AppSelect id={selectId} ariaLabel={title} value={value} onValueChange={onChange} options={options.map(([optionValue, label]) => ({ value: optionValue, label }))} /></label>;
}

export function GoalSetting({ count, accuracy, onChange }: { count: number; accuracy: number; onChange: (count: number, accuracy: number) => void }) {
  return <div className="preference-row goal-preference"><div><strong>每日练习目标</strong><p>首页按当天实际作答次数与正确率显示完成进度。</p></div><span><label>题数<input aria-label="每日目标题数" type="number" min="1" max="1000" value={count} onChange={(event) => onChange(Math.min(1000, Math.max(1, Number(event.target.value) || 1)), accuracy)} /></label><label>正确率<input aria-label="每日目标正确率" type="number" min="1" max="100" value={accuracy} onChange={(event) => onChange(count, Math.min(100, Math.max(1, Number(event.target.value) || 1)))} /><em>%</em></label></span></div>;
}

export function GroupSizeSetting({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  function commit() {
    const next = Math.min(500, Math.max(1, Math.floor(Number(draft) || value || 30)));
    setDraft(String(next));
    onChange(next);
  }
  return <label className="preference-row number-preference"><div><strong>每组题目数量</strong><p>用于首页推荐和“随机一组”练习；可填写 1–500 题。</p></div><span className="number-setting"><input aria-label="每组题目数量" type="number" min="1" max="500" step="1" inputMode="numeric" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><em>题</em></span></label>;
}

export function ToleranceSetting({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  function commit() {
    const parsed = Number(draft);
    const next = Math.min(100, Math.max(0, Number.isFinite(parsed) ? parsed : value));
    setDraft(String(next));
    onChange(next);
  }
  return <label className="preference-row number-preference"><div><strong>计算题允许误差</strong><p>按标准答案的相对误差比例判定；例如答案 100、误差 1% 时，99–101 都算正确。</p></div><span className="number-setting"><input aria-label="计算题允许误差" type="number" min="0" max="100" step="0.1" inputMode="decimal" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><em>%</em></span></label>;
}

export function BuildVersionCard() {
  const builtAt = formatBuildTimestamp();
  return <section className="preference-card version-card"><div className="settings-title"><span><BadgeInfo /></span><div><h2>客户端版本</h2><p>用于确认当前设备是否已经加载最新发布版本。</p></div></div><dl><div><dt>提交哈希</dt><dd><code>{__APP_COMMIT_SHA__.slice(0, 12)}</code></dd></div><div><dt>提交时间</dt><dd>{builtAt}</dd></div></dl></section>;
}

export function Practice({ runId, question, initialState, optionOrder, questionIds, questionTypes, answers, index, total, modeLabel, preferences, onStateChange, onJump, onFavorite, onPrevious, onNext, onFinish, onExit }: { runId: string; question: Question; initialState?: PracticeAnswerState; optionOrder?: number[]; questionIds: string[]; questionTypes: Record<string, QuestionType>; answers: Record<string, PracticeAnswerState>; index: number; total: number; modeLabel: string; preferences: PracticePreferences; onStateChange: (state: PracticeAnswerState) => void; onJump: (index: number) => void; onFavorite: () => Promise<void>; onPrevious: () => void; onNext: () => void; onFinish: () => void; onExit: () => void }) {
  const [selected, setSelected] = useState<string[]>(initialState?.selected ?? []);
  const [submitted, setSubmitted] = useState(initialState?.submitted ?? false);
  const [calculationDraft, setCalculationDraft] = useState(question.type === "计算" ? initialState?.selected[0] ?? "" : "");
  const [autoAdvancing, setAutoAdvancing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [startedAt] = useState(() => Date.now());
  const note = useLiveQuery(() => dbV6.notes.get(question.id), [question.id]);
  const attemptSummary = useLiveQuery(async () => summarizeV6AttemptStats(await dbV6.attemptStats.get(question.id)), [question.id]) ?? summarizeV6AttemptStats();
  const [draft, setDraft] = useState<string | null>(null);
  const [noteEditing, setNoteEditing] = useState(false);
  // 换题时退出编辑态（React 官方「渲染期间调整状态」模式，替代 effect 内 setState）。
  const lastNoteQuestionId = useRef(question.id);
  if (lastNoteQuestionId.current !== question.id) {
    lastNoteQuestionId.current = question.id;
    if (noteEditing) setNoteEditing(false);
  }
  const [noteSaveStatus, setNoteSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const autoNextTimer = useRef<number | undefined>(undefined);
  const copyStatusTimer = useRef<number | undefined>(undefined);
  const noteSaveTimer = useRef<number | undefined>(undefined);
  const draftRef = useRef("");
  const noteDirty = useRef(false);
  const answering = useRef(false);
  const chooseShortcutRef = useRef<(letter: string) => void>(() => undefined);
  const submitShortcutRef = useRef<() => void>(() => undefined);
  const questionCardRef = useRef<HTMLElement>(null);
  const swipeGesture = useRef<{ startX: number; startY: number; lastX: number; lastY: number; startScrollTop: number; axis: "pending" | "horizontal" | "vertical" } | null>(null);
  const effectiveDraft = draft ?? note?.content ?? "";
  const displayOrder = optionOrder?.length === question.options.length ? optionOrder : question.options.map((_, optionIndex) => optionIndex);
  const displayAnswer = displayedAnswer(question, displayOrder);
  const selectedCanonical = question.type === "计算" ? selected[0] ?? "" : [...selected].sort().join("");
  const selectedAnswer = question.type === "计算" ? selectedCanonical : selected
    .map((letter) => displayOrder.indexOf(letter.charCodeAt(0) - 65))
    .filter((displayIndex) => displayIndex >= 0)
    .map((displayIndex) => String.fromCharCode(65 + displayIndex))
    .sort()
    .join("");
  const correct = submitted && (question.type === "计算"
    ? isCalculationAnswerCorrect(selectedCanonical, question.answer, preferences.calculationTolerancePercent)
    : selectedCanonical === [...question.answer].sort().join(""));
  const gaveUp = submitted && selected.length === 0;
  const revealAnswer = submitted && (correct || preferences.showAnswerOnWrong);
  const isLast = index === total - 1;

  useEffect(() => {
    if (draft === null && note?.content !== undefined) draftRef.current = note.content;
  }, [draft, note?.content]);

  useEffect(() => () => {
    window.clearTimeout(autoNextTimer.current);
    window.clearTimeout(copyStatusTimer.current);
    window.clearTimeout(noteSaveTimer.current);
    if (noteDirty.current) void saveNote(question.id, draftRef.current);
  }, [question.id]);

  async function persistNoteDraft() {
    const content = draftRef.current;
    setNoteSaveStatus("saving");
    await saveNote(question.id, content);
    if (draftRef.current === content) {
      noteDirty.current = false;
      setNoteSaveStatus("saved");
    }
  }

  function changeNoteDraft(value: string) {
    setDraft(value);
    draftRef.current = value;
    noteDirty.current = true;
    setNoteSaveStatus("idle");
    window.clearTimeout(noteSaveTimer.current);
    noteSaveTimer.current = window.setTimeout(() => void persistNoteDraft(), 650);
  }

  useEffect(() => {
    if (window.matchMedia("(max-width: 760px)").matches) return;
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isEditingText = target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      if (editing || overviewOpen || isEditingText) return;
      const shortcut = resolveKeyboardShortcut(preferences.keyboardShortcuts, event);
      if (shortcut?.type === "option" && !event.repeat && !submitted && shortcut.optionIndex < displayOrder.length) {
        event.preventDefault();
        const originalIndex = displayOrder[shortcut.optionIndex];
        chooseShortcutRef.current(String.fromCharCode(65 + originalIndex));
      } else if (shortcut?.type === "confirm" && !event.repeat && !submitted) {
        event.preventDefault();
        submitShortcutRef.current();
      } else if (shortcut?.type === "previous" && index > 0) {
        event.preventDefault();
        window.clearTimeout(autoNextTimer.current);
        onPrevious();
      } else if (shortcut?.type === "next" && !isLast) {
        event.preventDefault();
        window.clearTimeout(autoNextTimer.current);
        onNext();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [displayOrder, editing, overviewOpen, index, isLast, onNext, onPrevious, preferences.keyboardShortcuts, submitted]);

  useEffect(() => {
    const card = questionCardRef.current;
    if (!card || !preferences.swipeNavigation) return;
    const interactiveSelector = "input, textarea, select, a, [contenteditable='true'], .practice-head button, .question-meta button, .practice-actions button";
    const resetGesture = () => { swipeGesture.current = null; };
    const onTouchStart = (event: TouchEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.touches.length !== 1 || target?.closest(interactiveSelector)) {
        resetGesture();
        return;
      }
      const touch = event.touches[0];
      const workspace = card.closest<HTMLElement>(".workspace");
      swipeGesture.current = { startX: touch.clientX, startY: touch.clientY, lastX: touch.clientX, lastY: touch.clientY, startScrollTop: workspace?.scrollTop ?? 0, axis: "pending" };
    };
    const onTouchMove = (event: TouchEvent) => {
      const gesture = swipeGesture.current;
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      gesture.lastX = touch.clientX;
      gesture.lastY = touch.clientY;
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      const horizontalDistance = Math.abs(dx);
      const verticalDistance = Math.abs(dy);
      if (gesture.axis === "pending") {
        if (Math.hypot(dx, dy) < 12) return;
        gesture.axis = horizontalDistance >= verticalDistance * .8 ? "horizontal" : "vertical";
      }
      if (gesture.axis !== "horizontal") return;
      if (event.cancelable) event.preventDefault();
      const workspace = card.closest<HTMLElement>(".workspace");
      if (workspace && workspace.scrollTop !== gesture.startScrollTop) workspace.scrollTop = gesture.startScrollTop;
    };
    const onTouchEnd = (event: TouchEvent) => {
      const gesture = swipeGesture.current;
      resetGesture();
      if (!gesture || gesture.axis !== "horizontal") return;
      const touch = event.changedTouches[0];
      const dx = (touch?.clientX ?? gesture.lastX) - gesture.startX;
      const dy = (touch?.clientY ?? gesture.lastY) - gesture.startY;
      const workspace = card.closest<HTMLElement>(".workspace");
      if (workspace) workspace.scrollTop = gesture.startScrollTop;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * .8) return;
      window.clearTimeout(autoNextTimer.current);
      if (dx < 0 && !isLast) onNext();
      else if (dx > 0 && index > 0) onPrevious();
      else return;
      window.requestAnimationFrame(() => workspace?.scrollTo({ top: 0, behavior: "auto" }));
    };
    card.addEventListener("touchstart", onTouchStart, { passive: true });
    card.addEventListener("touchmove", onTouchMove, { passive: false });
    card.addEventListener("touchend", onTouchEnd, { passive: true });
    card.addEventListener("touchcancel", resetGesture, { passive: true });
    return () => {
      card.removeEventListener("touchstart", onTouchStart);
      card.removeEventListener("touchmove", onTouchMove);
      card.removeEventListener("touchend", onTouchEnd);
      card.removeEventListener("touchcancel", resetGesture);
    };
  }, [index, isLast, onNext, onPrevious, preferences.swipeNavigation]);

  async function choose(letter: string) {
    if (submitted) return;
    if (question.type === "多选") {
      const next = selected.includes(letter) ? selected.filter((item) => item !== letter) : [...selected, letter];
      setSelected(next);
      onStateChange({ selected: next, submitted: false });
      return;
    }
    const value = [letter];
    setSelected(value);
    onStateChange({ selected: value, submitted: false });
    if (shouldSubmitOnChoice(question.type, preferences.submitOnSelect)) await submit(value);
  }

  chooseShortcutRef.current = (letter) => { void choose(letter); };

  async function selectAllOptions() {
    if (submitted || question.type !== "多选") return;
    const all = question.options.map((_, optionIndex) => String.fromCharCode(65 + optionIndex));
    setSelected(all);
    onStateChange({ selected: all, submitted: false });
    if (preferences.multiSelectAllAutoSubmit) await submit(all);
  }

  async function submit(valueList = selected) {
    const value = question.type === "计算" ? calculationDraft.trim() : [...valueList].sort().join("");
    if (!value || (question.type === "计算" && !Number.isFinite(Number(value))) || submitted || answering.current) return;
    answering.current = true;
    const finalSelection = question.type === "计算" ? [value] : valueList;
    const isCorrect = question.type === "计算"
      ? isCalculationAnswerCorrect(value, question.answer, preferences.calculationTolerancePercent)
      : value === [...question.answer].sort().join("");
    try {
      const result = await recordPracticeAnswer({ runId, questionId: question.id, bankId: question.bankId, selected: finalSelection, correct: isCorrect, elapsedMs: Date.now() - startedAt });
      setSelected(finalSelection);
      setSubmitted(true);
      onStateChange(result.answer);
    } catch {
      answering.current = false;
      return;
    }
    playAnswerFeedback(isCorrect, preferences);
    if (isCorrect && preferences.autoNextCorrect && !isLast) {
      setAutoAdvancing(true);
      autoNextTimer.current = window.setTimeout(onNext, preferences.autoNextDelayMs);
    }
  }

  submitShortcutRef.current = () => { void submit(); };

  async function giveUp() {
    if (submitted || answering.current) return;
    answering.current = true;
    try {
      const result = await recordPracticeAnswer({ runId, questionId: question.id, bankId: question.bankId, selected: [], correct: false, elapsedMs: Date.now() - startedAt });
      setSelected([]);
      setCalculationDraft("");
      setSubmitted(true);
      onStateChange(result.answer);
    } catch {
      answering.current = false;
      return;
    }
    playAnswerFeedback(false, preferences);
  }

  function retryQuestion() {
    window.clearTimeout(autoNextTimer.current);
    answering.current = false;
    setSelected([]);
    setCalculationDraft("");
    setSubmitted(false);
    setAutoAdvancing(false);
    onStateChange({ selected: [], submitted: false });
  }

  async function copyQuestion() {
    const optionLines = displayOrder.map((originalIndex, displayIndex) => `${String.fromCharCode(65 + displayIndex)}. ${question.options[originalIndex] ?? ""}`);
    const lines = [
      `题型：${question.type}`,
      `题目：${question.stem}`,
      "选项：",
      ...optionLines,
    ];
    if (submitted) {
      lines.push(`正确答案：${displayAnswer}`, `答案内容：${answerText(question, displayOrder)}`);
    }
    const text = lines.join("\n");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(text);
      setCopyStatus("copied");
    } catch {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) throw new Error("Copy command failed");
        setCopyStatus("copied");
      } catch { setCopyStatus("error"); }
    }
    window.clearTimeout(copyStatusTimer.current);
    copyStatusTimer.current = window.setTimeout(() => setCopyStatus("idle"), 1800);
  }

  return <><div className="practice-layout"><section ref={questionCardRef} className="question-card" data-no-pull-refresh><div className="practice-head"><button className="icon-button" aria-label="暂停并返回首页" onClick={onExit}><X size={19} /></button><div className="practice-progress"><span>{index + 1} / {total} · {modeLabel}</span><i><b style={{ width: `${(index + 1) / total * 100}%` }} /></i></div><div className="practice-head-actions"><button className="icon-button overview-trigger" aria-label="打开题目总览" onClick={() => setOverviewOpen(true)}><Grid3X3 size={18} /></button></div></div>
    <div className="question-body"><div className="question-meta"><span>{question.bankName}</span><em className="question-type-chip">{question.type}</em><em className={`difficulty-chip difficulty-${difficultyTone(attemptSummary.difficulty)}`}>难度 {attemptSummary.difficulty} · {difficultyLabel(attemptSummary.difficulty)}</em>{question.tags.map((tag) => <em key={tag}>{tag}</em>)}<button className={`copy-question ${copyStatus}`} aria-label={submitted ? "复制题目、选项和答案" : "复制题目和选项"} onClick={() => void copyQuestion()}>{copyStatus === "copied" ? <ClipboardCheck size={14} /> : <Copy size={14} />}{copyStatus === "copied" ? "已复制" : copyStatus === "error" ? "复制失败" : submitted ? "复制题目和答案" : "复制题目"}</button><button className={`favorite-question ${question.favorite ? "active" : ""}`} aria-label={question.favorite ? "取消收藏" : "收藏题目"} aria-pressed={Boolean(question.favorite)} onClick={() => void onFavorite()}><Star size={14} fill={question.favorite ? "currentColor" : "none"} />{question.favorite ? "已收藏" : "收藏"}</button><button className="edit-question-link" onClick={() => setEditing(true)}><Pencil size={13} />编辑题目</button></div><ContentBlockRenderer blocks={question.canonical.content} loadAsset={loadImageAssetV6} className="practice-stem" />{question.type === "多选" && !submitted && <div className="multi-select-toolbar"><span>多选题</span><small>{preferences.multiSelectAllAutoSubmit ? "全选后自动确认" : "全选后可继续调整"}</small><button type="button" onClick={() => void selectAllOptions()}><CheckCheck size={15} />全选</button></div>}{question.type === "计算" ? <div className={`calculation-answer ${submitted ? correct ? "correct" : "wrong" : ""}`}><label htmlFor={`calculation-answer-${question.id}`}>输入计算结果</label><input id={`calculation-answer-${question.id}`} aria-label="计算题答案" type="number" inputMode="decimal" value={submitted ? selectedCanonical : calculationDraft} disabled={submitted} onChange={(event) => setCalculationDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} placeholder={`允许误差 ${preferences.calculationTolerancePercent}%`} /><small>按标准答案的相对误差 ±{preferences.calculationTolerancePercent}% 判定</small></div> : <div className="options">{displayOrder.map((originalIndex, displayIndex) => { const option = question.canonical.options[originalIndex] ?? []; const originalLetter = String.fromCharCode(65 + originalIndex); const displayLetter = String.fromCharCode(65 + displayIndex); const isAnswer = revealAnswer && question.answer.includes(originalLetter); const isWrong = submitted && selected.includes(originalLetter) && !question.answer.includes(originalLetter); return <button key={originalLetter} className={`${selected.includes(originalLetter) ? "selected" : ""} ${isAnswer ? "right" : ""} ${isWrong ? "wrong" : ""}`} onClick={() => { if (!window.getSelection()?.toString()) void choose(originalLetter); }}><span>{displayLetter}</span><ContentBlockRenderer blocks={option} loadAsset={loadImageAssetV6} className="practice-option-content" />{isAnswer && <i className="option-status option-status-right" aria-hidden="true"><Check size={18} /></i>}{isWrong && <i className="option-status option-status-wrong" aria-hidden="true"><X size={18} /></i>}</button>; })}</div>}
      {submitted && <><div className={`result-box ${correct ? "success" : "error"}`}><strong>{correct ? (autoAdvancing ? "回答正确，即将进入下一题" : "回答正确") : gaveUp ? "已标记为不会，并计入错题" : "这次没有答对"}</strong>{correct ? <p>正确答案：{displayAnswer}</p> : preferences.showAnswerOnWrong ? <p>正确答案：{displayAnswer}｜你的选择：{selectedAnswer || "不会"}</p> : <p>正确答案已按配置隐藏｜你的选择：{selectedAnswer || "不会"}</p>}</div><div className="attempt-summary"><span><strong>{attemptSummary.total}</strong>总作答</span><span className="correct"><strong>{attemptSummary.correct}</strong>正确</span><span className="wrong"><strong>{attemptSummary.wrong}</strong>错误</span><span className={`difficulty difficulty-${difficultyTone(attemptSummary.difficulty)}`}><strong>{attemptSummary.difficulty}</strong>难度 · {difficultyLabel(attemptSummary.difficulty)}</span></div></>}
      {preferences.keyboardShortcuts.enabled && <div className="keyboard-hint">快捷键：确认 <kbd>{preferences.keyboardShortcuts.bindings.confirm.map(formatKeyboardShortcut).join(" / ") || "未设置"}</kbd> · 上一题 <kbd>{preferences.keyboardShortcuts.bindings.previous.map(formatKeyboardShortcut).join(" / ") || "未设置"}</kbd> · 下一题 <kbd>{preferences.keyboardShortcuts.bindings.next.map(formatKeyboardShortcut).join(" / ") || "未设置"}</kbd></div>}
      {preferences.swipeNavigation && <div className="swipe-hint"><ChevronLeft size={15} />右滑上一题 · 左滑下一题<ChevronRight size={15} /></div>}
    </div><div className={`practice-actions ${submitted ? "submitted" : ""} ${submitted && !correct && preferences.wrongReappearance === "immediate" ? "with-retry" : ""}`}><button className="secondary-action practice-previous" onClick={onPrevious} disabled={index === 0}><ChevronLeft size={18} />上一题</button><div>{!submitted && <button className="dont-know-action" onClick={() => void giveUp()}><CircleHelp size={17} />不会</button>}{!submitted && question.type !== "多选" && question.type !== "计算" && preferences.submitOnSelect && <span className="answer-action-hint">选择答案后立即判定</span>}{!submitted && (question.type === "计算" || question.type === "多选" || !preferences.submitOnSelect) && <button className="primary practice-submit" disabled={question.type === "计算" ? !calculationDraft.trim() || !Number.isFinite(Number(calculationDraft)) : !selected.length} onClick={() => void submit()}>确认答案</button>}{submitted && !correct && preferences.wrongReappearance === "immediate" && <button className="secondary-action retry-question" onClick={retryQuestion}><RefreshCw size={16} />立即重答</button>}{autoAdvancing ? <span className="answer-action-hint practice-auto-status">正在自动前进…</span> : <button className="practice-next" onClick={isLast ? onFinish : onNext}>{isLast ? "查看本次结果" : "下一题"}<ChevronRight size={18} /></button>}</div></div></section>
    {submitted && <aside className="note-panel"><div><NotebookPen size={18} /><strong>我的解析</strong></div>{!noteEditing && effectiveDraft.trim() ? <div className="note-panel-view" role="button" tabIndex={0} aria-label="编辑解析，支持 Markdown 与 LaTeX" onClick={() => setNoteEditing(true)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setNoteEditing(true); } }}><NoteMarkdown text={effectiveDraft} /></div> : <textarea value={effectiveDraft} onChange={(event) => changeNoteDraft(event.target.value)} onFocus={() => setNoteEditing(true)} onBlur={() => { if (effectiveDraft.trim()) setNoteEditing(false); }} placeholder="写下错因、口诀或区分条件…（支持 Markdown 与 LaTeX）" />}<span className={`note-save-status ${noteSaveStatus}`}>{noteSaveStatus === "saving" ? "正在自动保存…" : noteSaveStatus === "saved" ? "已自动保存" : "输入后自动保存"}</span><button className="edit-question-button" onClick={() => setEditing(true)}><Pencil size={15} />编辑题目与标签</button><small>切换题目或离开页面前会自动保存解析。</small></aside>}</div>{overviewOpen && <QuestionOverview questionIds={questionIds} questionTypes={questionTypes} answers={answers} currentIndex={index} onClose={() => setOverviewOpen(false)} onJump={(target) => { window.clearTimeout(autoNextTimer.current); onJump(target); setOverviewOpen(false); }} />}{editing && <SharedQuestionEditor question={question.canonical} preferredBankId={question.bankId} onCancel={() => setEditing(false)} onSaved={() => setEditing(false)} />}</>;
}

export function QuestionOverview({ questionIds, questionTypes, answers, currentIndex, onClose, onJump }: { questionIds: string[]; questionTypes: Record<string, QuestionType>; answers: Record<string, PracticeAnswerState>; currentIndex: number; onClose: () => void; onJump: (index: number) => void }) {
  const groupsRef = useRef<HTMLDivElement>(null);
  const focusButtonRef = useRef<HTMLButtonElement>(null);
  const answered = questionIds.filter((id) => answers[id]?.submitted).length;
  const correct = questionIds.filter((id) => answers[id]?.submitted && answers[id]?.correct).length;
  const wrong = answered - correct;
  const accuracy = answered ? Math.round(correct / answered * 100) : 0;
  const progress = questionOverviewProgress(answered, questionIds.length);

  // Bring the current question into the middle of the grid. The scroll formula
  // centres the focused button; when the current question is near either end it
  // cannot be centred, so the browser clamps scrollTop to the top/bottom limit
  // and the row rests against that edge instead.
  useLayoutEffect(() => {
    const groups = groupsRef.current;
    const button = focusButtonRef.current;
    if (!groups || !button) return;
    const groupsBox = groups.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    groups.scrollTop += buttonBox.top + buttonBox.height / 2 - groupsBox.top - groupsBox.height / 2;
  }, [currentIndex]);

  return <ModalPortal><div className="overview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="question-overview" role="dialog" aria-modal="true" aria-label="题目总览"><header><div><span className="section-kicker">练习导航</span><h2>题目总览</h2><p>已作答 {answered} / {questionIds.length}，点击题号快速切换。</p></div><button className="icon-button" aria-label="关闭题目总览" onClick={onClose}><X size={19} /></button></header><div className="overview-score"><span><strong>{correct}</strong>正确</span><span><strong>{wrong}</strong>错误</span><span><strong>{accuracy}%</strong>正确率</span><span><strong>{progress}</strong>进度</span></div><div className="overview-legend"><span><i className="correct" />正确</span><span><i className="wrong" />错误</span><span><i className="pending" />已选择</span><span><i />未作答</span></div><div className="overview-groups" ref={groupsRef}>{TYPE_ORDER.map((type) => { const group = questionIds.map((id, questionIndex) => ({ id, questionIndex })).filter(({ id }) => questionTypes[id] === type); return <section className="overview-group" key={type}><div><h3>{type}</h3><span>{group.length} 题</span></div>{group.length ? <div className="overview-number-grid">{group.map(({ id, questionIndex }) => { const answer = answers[id]; const state = answer?.submitted ? answer.correct ? "correct" : "wrong" : answer?.selected.length ? "pending" : "blank"; return <button ref={questionIndex === currentIndex ? focusButtonRef : undefined} data-overview-focus={questionIndex === currentIndex ? "true" : undefined} key={`${id}-${questionIndex}`} className={`${state} ${questionIndex === currentIndex ? "current" : ""}`} aria-label={`第 ${questionIndex + 1} 题，${type}`} aria-current={questionIndex === currentIndex ? "true" : undefined} onClick={() => onJump(questionIndex)}>{questionIndex + 1}</button>; })}</div> : <p className="overview-empty">本次练习没有{type}题</p>}</section>; })}</div></section></div></ModalPortal>;
}