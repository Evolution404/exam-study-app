"use client";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronRight, ClipboardCheck, Cloud, Home, Library, Link2, ListFilter, LoaderCircle, Menu, Play, RefreshCw, Settings2, Sparkles, X } from "lucide-react";
import { dbV7, getV7DeviceId, createPracticeRunV7, rebuildAttemptStatsFromAttemptsV7 } from "@/lib/db/db-v7";
import { getQuestionViewV7, listQuestionViewsForBanksV7 } from "@/lib/db/app-data-v7";
import { syncApplication, type SyncProgress, type SyncHotWindowState } from "@/lib/sync/sync-application";
import { syncRuntime } from "@/lib/sync/sync-runtime";
import { calendarDate, statsNeedWrongReview } from "@/lib/practice/practice-metrics";
import { toQuestionViewModel } from "@/app/bank/question-editor";
import type { SearchPracticeOptions } from "@/app/search/search-view";
import type { SearchContentScope } from "@/app/search/search-matching";
import { useSmoothProgress } from "@/app/practice/use-smooth-progress";
import { QuickSearch } from "@/app/search/quick-search";
import { ConfirmDialog } from "@/app/ui/confirm-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useAppTheme, useAppViewport } from "@/app/hooks/use-app-environment";
import { classifyPressIntent, QUICK_RESTORE_HOLD_MS } from "@/lib/practice/press-intent";
import type { ActivePractice, GitHubSettings } from "@/types/types";
import { buildScopedQuestionStats, calculateProgressCompletion, normalizeProgressScope, isQuestionDoneInScope, progressScopeLabel, scopedStatsToLegacyAttemptStats, summarizeScopedQuestionStats } from "@/lib/practice/progress-scope";
import { classifyNoticeTone } from "@/lib/practice/notice-tone";
import { importQuestionBankFile, QUESTION_BANK_FILE_ACCEPT } from "@/lib/question/question-bank-file-import";
import { SyncEventDrawer } from "@/app/sync/sync-event-drawer";
import { BankLibraryView, KnowledgeView, LatestPracticeBanner, PracticeHistory, PracticeRunResult, PracticeSetupView, SCROLL_RESTORABLE_VIEWS, SearchView, SyncView, TYPE_ORDER, activePracticeFromRun, balancedRandomSample, formatBuildTimestampShort, loadPreferences, loadSelectedBankIds, modeLabels, quickFilter, randomOptionOrder, savePracticeProgress, setPracticeRunStatus, deletePracticeRun, shuffle, summarizeV7AttemptStats, toggleQuestionFavorite, type PracticeAnswerState, type PracticeFilter, type PracticePreferences, type PracticeRun, type View } from "./helpers";
import { Dashboard, Practice, PreferencesView, PullToRefresh } from "./views";

export function AppShell() {
  const [view, setView] = useState<View>("home");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [searchContentScope, setSearchContentScope] = useState<SearchContentScope>("all");
  const [searchQuestionId, setSearchQuestionId] = useState<string>();
  const [searchRevision, setSearchRevision] = useState(0);
  const [groupQuestionIds, setGroupQuestionIds] = useState<string[]>([]);
  const [practiceSession, setPracticeSession] = useState<ActivePractice | null>(null);
  const [practiceTransitionDirection, setPracticeTransitionDirection] = useState<1 | -1>(1);
  const [selectedBankIds, setSelectedBankIds] = useState<string[]>(loadSelectedBankIds);
  const [preferences, setPreferences] = useState<PracticePreferences>(loadPreferences);
  const [discardedRun, setDiscardedRun] = useState<PracticeRun | null>(null);
  const [practiceHubTab, setPracticeHubTab] = useState<"start" | "history">("start");
  const [resultRunId, setResultRunId] = useState<string>();
  const [quickSyncing, setQuickSyncing] = useState(false);
  const [quickRestoring, setQuickRestoring] = useState(false);
  const [quickSyncProgress, setQuickSyncProgress] = useState<SyncProgress>();
  const smoothQuickSyncProgress = useSmoothProgress(quickSyncProgress);
  const [quickSyncHolding, setQuickSyncHolding] = useState(false);
  const [syncDrawerOpen, setSyncDrawerOpen] = useState(false);
  const [drawerHotWindow, setDrawerHotWindow] = useState<SyncHotWindowState | null>(null);
  const [drawerSyncedAt, setDrawerSyncedAt] = useState<string | null>(null);
  const [quickRestorePrompt, setQuickRestorePrompt] = useState<{ settings: GitHubSettings; cachedAt: string; questionCount: number }>();
  const [quickRestoreSuccess, setQuickRestoreSuccess] = useState<string>();
  const [finishPrompt, setFinishPrompt] = useState<number>();
  const fileRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const viewScrollPositions = useRef<Partial<Record<View, number>>>({});
  const quickSyncPress = useRef<{ timer: number; pointerId: number; startX: number; startY: number; startedAt: number; longPressed: boolean; cancelled: boolean } | null>(null);
  const resetQuickSyncPress = useCallback((cancelPendingRestore = true) => {
    const press = quickSyncPress.current;
    if (press) {
      window.clearTimeout(press.timer);
      // A lifecycle cancellation must also invalidate an async restore lookup.
      // Pointerup after a completed hold passes false so that lookup may finish
      // and show the restore confirmation after the finger leaves the button.
      if (cancelPendingRestore) press.cancelled = true;
    }
    quickSyncPress.current = null;
    setQuickSyncHolding(false);
  }, []);
  // 同步是异步操作，await 期间 practiceSession 闭包会过期（用户可能正好提交了答案）。
  // 渲染期镜像到 ref，同步结束后读最新快照（同 Practice 组件的 lastNoteQuestionId 模式）。
  const practiceSessionRef = useRef(practiceSession);
  practiceSessionRef.current = practiceSession;

  useAppViewport();
  useAppTheme(preferences.themeMode);

  useEffect(() => {
    void syncApplication.ensureQueueBase();
    // 一次性迁移：为 attemptStats.recentOutcomes 补作答时间（难度 v2 需要）。
    // attemptStats 是纯派生数据，重建幂等；同步拉取后 deriveAttemptStats 也会自然带出。
    if (!localStorage.getItem("study-v7-stats-outcomes-v2")) {
      localStorage.setItem("study-v7-stats-outcomes-v2", "1");
      void rebuildAttemptStatsFromAttemptsV7();
    }
  }, []);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const positions = viewScrollPositions.current;
    workspace.scrollTop = SCROLL_RESTORABLE_VIEWS.includes(view) ? positions[view] ?? 0 : 0;
  }, [view]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || !SCROLL_RESTORABLE_VIEWS.includes(view)) return;
    const positions = viewScrollPositions.current;
    const rememberPosition = () => { positions[view] = workspace.scrollTop; };
    workspace.addEventListener("scroll", rememberPosition, { passive: true });
    return () => workspace.removeEventListener("scroll", rememberPosition);
  }, [view]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), notice === "已放弃上次练习" ? 6000 : 3000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  function handleRestoreSuccess(message: string) {
    // Restoring replaces the IndexedDB contents while this component is still
    // mounted. Reset transient React state so live queries can render the new
    // data without requiring a full document reload.
    localStorage.removeItem("study-current-banks");
    setView("home");
    setSidebarOpen(false);
    setNotice("");
    setQuery("");
    setSearchContentScope("all");
    setSearchQuestionId(undefined);
    setSearchRevision((revision) => revision + 1);
    setGroupQuestionIds([]);
    setPracticeSession(null);
    setSelectedBankIds([]);
    setDiscardedRun(null);
    setPracticeHubTab("start");
    setResultRunId(undefined);
    setFinishPrompt(undefined);
    setQuickSyncing(false);
    setQuickRestoring(false);
    setQuickSyncHolding(false);
    setQuickSyncProgress(undefined);
    setQuickRestorePrompt(undefined);
    if (quickSyncPress.current) window.clearTimeout(quickSyncPress.current.timer);
    quickSyncPress.current = null;
    viewScrollPositions.current = {};
    workspaceRef.current?.scrollTo({ top: 0, behavior: "auto" });
    setQuickRestoreSuccess(message);
  }


  const banks = useLiveQuery(async () => (await dbV7.banks.toArray()).sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.importedAt.localeCompare(b.importedAt)), []) ?? [];
  const validSelectedBankIds = selectedBankIds.filter((id) => banks.some((bank) => bank.id === id));
  const activeBankIds = validSelectedBankIds;
  const latestPracticeRun = useLiveQuery(async () => {
    return dbV7.practiceRuns.where("status").equals("in_progress").sortBy("updatedAt").then((runs) => runs.at(-1));
  }, []);
  const activeQuestionId = practiceSession?.questionIds[practiceSession.currentIndex];
  const activeQuestion = useLiveQuery(async () => {
    if (!activeQuestionId) return undefined;
    const view = await getQuestionViewV7(activeQuestionId, practiceSession?.bankId);
    // null = 已解析但题目不存在（本机或后台同步删除），区别于加载中的 undefined，
    // 供下方「跳过已删题」effect 判定当前题已消失。
    if (!view) return null;
    const bank = view.banks.find((item) => item.id === view.sourceBankId) ?? view.banks[0];
    const membership = view.memberships.find((item) => item.bankId === view.sourceBankId) ?? view.memberships[0];
    return toQuestionViewModel(view.question, view.sourceBankId ?? "", bank?.displayName || bank?.name || "未归档题目", membership?.sortOrder ?? 0);
  }, [activeQuestionId, practiceSession?.bankId]);

  // 练习中当前题被删除（本机管理或后台同步拉取）时自动跳过；若练习内已无存活的题，
  // 则保存已作答并结束进入结果页。删除操作已把该题从持久化 run 里剔除，这里只需对齐内存会话。
  useEffect(() => {
    if (view !== "practice" || !practiceSession || activeQuestion !== null || !activeQuestionId) return;
    const deletedId = activeQuestionId;
    const survivors = practiceSession.questionIds.filter((id) => id !== deletedId);
    // activeQuestion 用 useLiveQuery 解析（异步）；session 刚被本 effect 裁剪后到 liveQuery
    // 重解析之间存在窗口，此时 activeQuestion 仍为 null 但题目其实还在。直接查 DB 确认真伪，
    // 避免把「liveQuery 尚未刷新」误判为删除，导致连环跳过把整组题清空。
    let cancelled = false;
    void (async () => {
      const stillExists = await getQuestionViewV7(deletedId, practiceSession.bankId);
      if (cancelled || stillExists) return; // 题目还在，只是 liveQuery 没刷新，不跳过
      if (!survivors.length) {
        setNotice("练习中的题目已被删除，本次练习结束");
        const answers = Object.fromEntries(Object.entries(practiceSession.answers).filter(([id]) => id !== deletedId));
        const runId = practiceSession.runId;
        setPracticeSession(null);
        void setPracticeRunStatus(runId, "completed", answers).then(() => {
          setResultRunId(runId);
          setFinishPrompt(undefined);
          setView("practiceResult");
        });
        return;
      }
      changeSession((session) => {
        if (!session.questionIds.includes(deletedId)) return session;
        const answers = Object.fromEntries(Object.entries(session.answers).filter(([id]) => id !== deletedId));
        const questionTypes = Object.fromEntries(Object.entries(session.questionTypes ?? {}).filter(([id]) => id !== deletedId));
        const nextQuestionIds = session.questionIds.filter((id) => id !== deletedId);
        let lastAnsweredIndex = -1;
        nextQuestionIds.forEach((id, index) => { if (session.answers[id]?.submitted) lastAnsweredIndex = index; });
        return {
          ...session,
          questionIds: nextQuestionIds,
          answers,
          questionTypes,
          currentIndex: Math.min(session.currentIndex, nextQuestionIds.length - 1),
          lastAnsweredIndex,
        };
      });
      setNotice("题目已删除，自动跳过");
    })();
    return () => { cancelled = true; };
  }, [activeQuestion, activeQuestionId, practiceSession, view]);

  // E3: 删除题库（本机管理或后台同步拉取）会硬删活动 run 行并写墓碑，但 React 的 practiceSession
  // 仍是陈旧快照——继续答题时 savePracticeProgress 会命中 if(!current) return 而静默丢答案（幽灵会话）。
  // 监听当前 run 行是否存在，消失时置空会话、回首页并提示。activeRunExists 用 false 显式区分
  // 「已解析且不存在」与加载中的 undefined。
  const activeRunExists = useLiveQuery(async () => {
    if (!practiceSession) return undefined;
    return Boolean(await dbV7.practiceRuns.get(practiceSession.runId));
  }, [practiceSession?.runId]);
  useEffect(() => {
    if (view !== "practice" || !practiceSession || activeRunExists !== false) return;
    queueMicrotask(() => {
      setPracticeSession(null);
      setView("home");
      setNotice("本次练习对应的题库已被删除，练习已结束");
    });
  }, [activeRunExists, practiceSession, view]);
  const statsBaseQuery = useLiveQuery(async () => {
    const today = calendarDate(new Date());
    const [questions, attemptStats, todayRows, notes] = await Promise.all([
      dbV7.questions.count(), dbV7.attemptStats.toArray(), dbV7.attemptDailyStats.where("date").equals(today).toArray(),
      dbV7.notes.count(),
    ]);
    const totals = attemptStats.reduce((result, row) => ({ attempts: result.attempts + row.total, correct: result.correct + row.correct }), { attempts: 0, correct: 0 });
    const todayTotals = todayRows.reduce((result, row) => ({ attempts: result.attempts + row.total, correct: result.correct + row.correct }), { attempts: 0, correct: 0 });
    const last = [...attemptStats].sort((a, b) => b.latestAttemptAt.localeCompare(a.latestAttemptAt))[0];
    return {
      questions,
      attempts: totals.attempts,
      correct: totals.correct,
      todayAttempts: todayTotals.attempts,
      todayCorrect: todayTotals.correct,
      notes,
      last: last?.latestAttemptAt,
    };
  }, []);
  // 待同步计数单独订阅：同步过程会翻转 changeSets 状态 3–5 次（claim/commit/
  // blocked/prune），若与重型 stats 查询（attemptStats 全表）绑在一起，每次翻转
  // 都会连带重跑全表统计并重渲染整棵树。
  const pendingCountQuery = useLiveQuery(() => syncApplication.pendingCount(), []);
  const stats = useMemo(() => {
    const base = statsBaseQuery ?? { questions: 0, attempts: 0, correct: 0, todayAttempts: 0, todayCorrect: 0, notes: 0, last: undefined };
    return { ...base, pending: pendingCountQuery ?? 0 };
  }, [statsBaseQuery, pendingCountQuery]);
  // The `?? []` fallback must be memoised too, otherwise its fresh array on
  // every render would defeat the dependency check below.
  const syncItemsRaw = useLiveQuery(
    () => syncDrawerOpen ? syncApplication.listQueueItems(300) : Promise.resolve([]),
    [syncDrawerOpen],
  );
  // 队列依赖解析已下沉到 sync-application；抽屉关闭时不查询也不渲染列表。
  const syncItems = useMemo(() => syncDrawerOpen ? (syncItemsRaw ?? []) : [], [syncItemsRaw, syncDrawerOpen]);
  const reviewRounds = useLiveQuery(() => dbV7.reviewRounds.orderBy("updatedAt").reverse().toArray(), []) ?? [];
  const normalizedProgressScope = normalizeProgressScope(preferences.progressScope);
  const selectedScopeLabel = normalizedProgressScope.type === "round"
    ? reviewRounds.find((round) => round.id === normalizedProgressScope.roundId)?.name || "当前复习轮次"
    : progressScopeLabel(normalizedProgressScope);
  const activeBankKey = activeBankIds.join("|");
  const scopeProgress = useLiveQuery(async () => {
    if (view !== "home") return { completed: 0, total: 0 };
    if (!activeBankIds.length) return { completed: 0, total: 0 };
    const [questions, stats, roundProgress] = await Promise.all([listQuestionViewsForBanksV7(activeBankIds), dbV7.attemptStats.toArray(), dbV7.reviewRoundProgress.toArray()]);
    const ids = [...new Set(questions.map((view) => view.question.id))];
    const completion = calculateProgressCompletion(ids, normalizeProgressScope(preferences.progressScope), stats, roundProgress, Date.now());
    return { completed: completion.completed, total: completion.total };
  }, [view, activeBankKey, preferences.progressScope]) ?? { completed: 0, total: 0 };
  const scopeStats = useLiveQuery(async () => {
    if (view !== "home") return { questions: 0, attempts: 0, correct: 0, notes: 0, last: undefined, bankCount: 0 };
    const questionIds = activeBankIds.length
      ? [...new Set((await dbV7.bankQuestionMemberships.where("bankId").anyOf(activeBankIds).toArray()).map((membership) => membership.questionId))]
      : await dbV7.questions.toCollection().primaryKeys();
    const [attempts, roundProgress, notes] = await Promise.all([
      dbV7.attempts.toArray(), dbV7.reviewRoundProgress.toArray(), dbV7.notes.toArray(),
    ]);
    const questionIdSet = new Set(questionIds);
    const summary = summarizeScopedQuestionStats(buildScopedQuestionStats(questionIds, normalizedProgressScope, attempts, roundProgress, Date.now()));
    return {
      questions: questionIds.length,
      attempts: summary.attempts,
      correct: summary.correct,
      notes: notes.filter((note) => questionIdSet.has(note.questionId) && note.content.trim()).length,
      last: summary.lastAttemptAt,
      bankCount: activeBankIds.length || banks.length,
    };
  }, [view, activeBankKey, preferences.progressScope, banks.length]) ?? { questions: 0, attempts: 0, correct: 0, notes: 0, last: undefined, bankCount: activeBankIds.length || banks.length };

  // 往既有题库继续导入：试题管理头部「导入题目」先记下目标题库再复用同一个
  // 隐藏文件输入。ref 而非 state——不触发重渲染，也无陈旧闭包。
  const importTargetBankIdRef = useRef<string | undefined>(undefined);
  function importIntoBank(bankId: string) {
    importTargetBankIdRef.current = bankId;
    fileRef.current?.click();
  }

  async function onImport(file?: File) {
    if (!file) return;
    const targetBankId = importTargetBankIdRef.current;
    try {
      setNotice("正在识别并校验题库…");
      const { bank, importedCount, type } = await importQuestionBankFile(file, targetBankId ? { targetBankId } : undefined);
      if (targetBankId) {
        setNotice(`已从 ${type === "xlsx" ? "Excel" : type === "zip" ? "压缩包" : "JSON"} 导入 ${importedCount} 道题到「${bank.displayName || bank.name}」`);
        // 留在题库详情（试题管理 tab 保持打开，liveQuery 自动刷新题目列表）。
      } else {
        setNotice(`已从 ${type === "xlsx" ? "Excel" : type === "zip" ? "压缩包" : "JSON"} 导入「${bank.displayName || bank.name}」的 ${bank.questionCount} 道题`);
        setView("banks");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "题库导入失败");
    } finally {
      importTargetBankIdRef.current = undefined;
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function selectBanks(bankIds: string[]) {
    const unique = [...new Set(bankIds)];
    setSelectedBankIds(unique);
    localStorage.setItem("study-current-banks", JSON.stringify(unique));
  }

  function toggleBank(bankId: string) {
    const next = activeBankIds.includes(bankId) ? activeBankIds.filter((id) => id !== bankId) : [...activeBankIds, bankId];
    selectBanks(next);
  }

  async function discardSavedPractice(runId: string) {
    const run = await dbV7.practiceRuns.get(runId);
    if (!run || run.status !== "in_progress") return;
    setDiscardedRun(run);
    await setPracticeRunStatus(run.id, "abandoned", run.answers);
    if (practiceSession?.runId === run.id) setPracticeSession(null);
    setNotice("已放弃上次练习");
  }

  async function undoDiscardPractice() {
    if (!discardedRun) return;
    await setPracticeRunStatus(discardedRun.id, "in_progress", discardedRun.answers);
    setDiscardedRun(null);
    setNotice("已恢复上次练习");
  }

  function updatePreferences(value: PracticePreferences) {
    setPreferences(value);
    localStorage.setItem("study-v7-preferences", JSON.stringify(value));
  }

  // 用户显式点同步拉取后刷新进行中的练习：另一设备对同一 run 的作答已合并进
  // DB，但 practiceSession 是打开练习时的内存快照，不刷新就看不到新进度。有新
  // 作答时切到最后一道做完的题；没有新作答则只静默对齐数据（题干等可能被远端
  // 编辑），不打断当前答题。后台定期拉取不调用它（避免打扰正在答题的用户）。
  async function refreshActivePracticeAfterSync() {
    const session = practiceSessionRef.current;
    if (!session) return;
    const run = await dbV7.practiceRuns.get(session.runId);
    if (!run) return; // run 行消失（题库被删）交给 E3 守卫处理
    if (run.status !== "in_progress") {
      // run 已被另一设备结束/放弃，本机快照成幽灵会话，直接收尾。
      setPracticeSession(null);
      if (run.status === "completed") {
        setResultRunId(run.id);
        setView("practiceResult");
        setNotice("本次练习已在其他设备完成，已切换到结果页");
      } else {
        setView("home");
        setNotice("本次练习已在其他设备被放弃，练习已结束");
      }
      return;
    }
    const incoming = run.questionIds.filter((id) => run.answers[id]?.submitted && !session.answers[id]?.submitted);
    if (!incoming.length) {
      setPracticeSession(activePracticeFromRun(run, session.currentIndex));
      return;
    }
    let lastAnsweredIndex = -1;
    run.questionIds.forEach((id, index) => { if (run.answers[id]?.submitted) lastAnsweredIndex = index; });
    setPracticeTransitionDirection(lastAnsweredIndex >= session.currentIndex ? 1 : -1);
    setPracticeSession(activePracticeFromRun(run, Math.max(0, lastAnsweredIndex)));
    setNotice(`已同步本练习 ${incoming.length} 道新作答，切换到最后一道做完的题`);
  }

  async function quickSync({ silent = false }: { silent?: boolean } = {}) {
    if (syncRuntime.isBusy() || quickRestoring) return;
    const connection = syncApplication.getConnection();
    if (!connection.ready) {
      if (!silent) {
        setNotice("请先在配置页面填写 GitHub 令牌");
        setView(window.matchMedia("(max-width: 760px)").matches ? "preferences" : "settings");
      }
      return;
    }
    try {
      if (!silent) {
        setQuickSyncing(true);
        setQuickSyncProgress({ phase: "prepare", label: "正在准备同步", percent: 0 });
      }
      const result = await syncRuntime.sync(silent ? undefined : setQuickSyncProgress);
      if (!silent) {
        const received = result.receivedSnapshot
          ? `接收 ${result.receivedSnapshot.questions.toLocaleString("zh-CN")} 道题、${result.receivedSnapshot.totalAttempts.toLocaleString("zh-CN")} 条作答`
          : `接收 ${result.pulled} 组操作`;
        setNotice(`同步完成：上传 ${result.pushed} 组操作，${received}${result.compacted ? "，远程数据已压缩" : ""}${result.remaining ? `，待同步 ${result.remaining} 组操作` : ""}`);
      }
      if (result.pulled || result.receivedSnapshot) await refreshActivePracticeAfterSync();
    } catch (error) {
      if (!silent) setNotice(error instanceof Error ? error.message : "同步失败，请检查令牌和网络");
    } finally {
      if (!silent) {
        setQuickSyncing(false);
        setQuickSyncProgress(undefined);
      }
    }
  }

  // 同步抽屉打开时（以及抽屉开着时一次快速同步结束）刷新热窗口状态，
  // 抽屉内展示与同步页完全一致的信息面板。
  useEffect(() => {
    if (!syncDrawerOpen) return;
    const settings = syncApplication.getConnection().settings;
    let active = true;
    const load = settings.repo
      ? Promise.all([syncApplication.getLastRemoteCache(settings), syncApplication.getHotWindow(settings)]).then(([cache, hotWindow]) => ({ hotWindow, syncedAt: cache?.cachedAt ?? null }))
      : Promise.resolve({ hotWindow: null, syncedAt: null });
    void load.then((value) => {
      if (!active) return;
      setDrawerHotWindow(value.hotWindow);
      setDrawerSyncedAt(value.syncedAt);
    });
    return () => { active = false; };
  }, [syncDrawerOpen, quickSyncing]);

  // Mobile Safari may leave a captured pointer without dispatching pointerup
  // when the user switches apps, the page is hidden, or the window loses focus.
  // Always cancel the press in those lifecycle cases: a stale press must never
  // turn the next tap into an accidental restore or an unresponsive button.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") resetQuickSyncPress();
    };
    const cancelOnLifecycle = () => resetQuickSyncPress();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", cancelOnLifecycle);
    window.addEventListener("blur", cancelOnLifecycle);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", cancelOnLifecycle);
      window.removeEventListener("blur", cancelOnLifecycle);
    };
  }, [resetQuickSyncPress]);

  useEffect(() => {
    return syncRuntime.scheduleAutomaticSync({
      enabled: preferences.autoSyncEnabled,
      pending: stats.pending,
      threshold: preferences.autoSyncEventThreshold,
      blocked: quickRestoring,
      onError: () => undefined,
    });
  }, [preferences.autoSyncEnabled, preferences.autoSyncEventThreshold, quickRestoring, stats.pending]);

  useEffect(() => {
    return syncRuntime.startPeriodicPull({
      enabled: preferences.periodicPullEnabled,
      seconds: preferences.periodicPullSeconds,
      blocked: () => quickRestoring,
      onError: (error) => setNotice(error instanceof Error ? `定期拉取失败：${error.message}` : "定期拉取失败"),
    });
  }, [preferences.periodicPullEnabled, preferences.periodicPullSeconds, quickRestoring]);

  async function prepareQuickRestore(press?: { cancelled: boolean }) {
    if (quickSyncing || quickRestoring) return;
    const settings: GitHubSettings = syncApplication.getConnection().settings;
    if (!settings.owner || !settings.repo) {
      setNotice("本机还没有远程缓存，请先成功同步一次");
      return;
    }
    try {
      const cached = await syncApplication.getLastRemoteCache(settings);
      if (!cached) {
        setNotice("本机还没有远程缓存，请先成功同步一次");
        return;
      }
      if (press?.cancelled) return;
      setQuickRestorePrompt({ settings, cachedAt: cached.cachedAt, questionCount: cached.counts.questions });
    } catch (error) {
      if (press?.cancelled) return;
      setNotice(error instanceof Error ? error.message : "无法读取本地恢复记录");
    }
  }

  async function confirmQuickRestore() {
    if (!quickRestorePrompt || quickRestoring) return;
    try {
      setQuickRestoring(true);
      setQuickSyncProgress({ phase: "prepare", label: "正在准备恢复", percent: 0 });
      const result = await syncApplication.restoreCache(quickRestorePrompt.settings, setQuickSyncProgress);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
      setQuickRestorePrompt(undefined);
      setQuickRestoring(false);
      setQuickSyncProgress(undefined);
      handleRestoreSuccess(`已从本机缓存恢复 ${result.counts.questions} 道题及对应学习记录。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "本地缓存恢复失败");
      setQuickRestoring(false);
      setQuickSyncProgress(undefined);
    }
  }

  function beginQuickSyncPress(event: ReactPointerEvent<HTMLButtonElement>) {
    if (quickSyncing || quickRestoring || (event.pointerType === "mouse" && event.button !== 0)) return;
    // A previous interrupted pointer sequence should not poison the next tap.
    resetQuickSyncPress();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a progressive enhancement; pointerup/cancel still
      // finish the sequence on browsers that reject capture.
    }
    const press = {
      timer: 0,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: event.timeStamp,
      longPressed: false,
      cancelled: false,
    };
    press.timer = window.setTimeout(() => {
      press.longPressed = true;
      void prepareQuickRestore(press).finally(() => {
        // Do not let an old, completed press clear the holding UI of a newer
        // press that started while its cache lookup was still pending.
        if (quickSyncPress.current === press) setQuickSyncHolding(false);
      });
    }, QUICK_RESTORE_HOLD_MS);
    quickSyncPress.current = press;
    setQuickSyncHolding(true);
  }

  function moveQuickSyncPress(event: ReactPointerEvent<HTMLButtonElement>) {
    const press = quickSyncPress.current;
    if (!press || press.pointerId !== event.pointerId || press.longPressed) return;
    const dx = event.clientX - press.startX;
    const dy = event.clientY - press.startY;
    // Ignore ordinary finger jitter. Cancel only an obvious vertical scroll
    // (vertical motion dominates) or a larger horizontal escape from the pill.
    // This keeps a small mobile tremor from cancelling a valid sync tap while
    // still yielding to an intentional page gesture.
    const verticalScroll = Math.abs(dy) >= 18 && Math.abs(dy) >= Math.abs(dx) * 1.2;
    const horizontalEscape = Math.abs(dx) >= 24;
    if (!verticalScroll && !horizontalEscape) return;
    window.clearTimeout(press.timer);
    press.cancelled = true;
    setQuickSyncHolding(false);
  }

  function endQuickSyncPress(event: ReactPointerEvent<HTMLButtonElement>) {
    const press = quickSyncPress.current;
    if (!press || press.pointerId !== event.pointerId) return;
    const intent = classifyPressIntent(event.timeStamp - press.startedAt, press.cancelled, press.longPressed);
    if (intent === "tap") {
      resetQuickSyncPress();
      void quickSync();
    }
    // The timer normally prepares restore as soon as the threshold is reached.
    // Keep this fallback for browsers with delayed timers, but never sync a
    // completed long press.
    else if (intent === "complete") {
      if (!press.longPressed) void prepareQuickRestore(press);
      resetQuickSyncPress(false);
    } else {
      resetQuickSyncPress();
    }
  }

  function cancelQuickSyncPress(event: ReactPointerEvent<HTMLButtonElement>) {
    const press = quickSyncPress.current;
    if (!press || press.pointerId !== event.pointerId) return;
    resetQuickSyncPress();
  }

  async function startPractice(filter: PracticeFilter) {
    let requestedBankIds = [...new Set(filter.bankIds)];
    if (filter.reviewRoundId) {
      const round = await dbV7.reviewRounds.get(filter.reviewRoundId);
      if (!round || round.status !== "active") {
        setNotice("这条复习轮次已不存在或已结束，请重新选择。");
        return;
      }
      // A round owns its dynamic bank membership. Re-read it at start time so
      // a stale setup screen can never create a run against another scope.
      requestedBankIds = [...new Set(round.bankIds)];
    }
    const practiceBanks = banks.filter((item) => requestedBankIds.includes(item.id));
    if (!practiceBanks.length) {
      setNotice("请先选择一个题库");
      return;
    }
    // app-data-v7 joins memberships and deliberately de-duplicates shared
    // global questions across the selected banks.
    let questions = (await listQuestionViewsForBanksV7(requestedBankIds)).map((view) => {
      const bank = view.banks.find((item) => item.id === view.sourceBankId) ?? view.banks[0];
      const membership = view.memberships.find((item) => item.bankId === view.sourceBankId) ?? view.memberships[0];
      return toQuestionViewModel(view.question, view.sourceBankId ?? "", bank?.displayName || bank?.name || "未归档题目", membership?.sortOrder ?? 0);
    });
    questions = questions.filter((question) => filter.types.includes(question.type));
    if (filter.tags.length) questions = questions.filter((question) => filter.tagMatch === "all"
      ? filter.tags.every((tag) => question.tags.includes(tag))
      : filter.tags.some((tag) => question.tags.includes(tag)));
    if (filter.keyword.trim()) {
      const keyword = filter.keyword.trim();
      let pattern: RegExp | null = null;
      if (filter.keywordMode === "regex") {
        try { pattern = new RegExp(keyword, "i"); } catch { setNotice("正则表达式格式不正确，请检查后重试"); return; }
      }
      questions = questions.filter((question) => {
        const searchable = [question.stem, ...question.options, ...question.tags].join("\n");
        return pattern ? pattern.test(searchable) : searchable.toLocaleLowerCase("zh-CN").includes(keyword.toLocaleLowerCase("zh-CN"));
      });
    }
    const [statsRows, roundProgress, attemptRows] = await Promise.all([dbV7.attemptStats.toArray(), dbV7.reviewRoundProgress.toArray(), dbV7.attempts.toArray()]);
    const attemptMetrics = new Map(statsRows.map((stats) => [stats.questionId, summarizeV7AttemptStats(stats)]));
    const progressScope = normalizeProgressScope(filter.progressScope ?? preferences.progressScope);
    const lastAttemptFrom = filter.lastAttemptFrom ? new Date(`${filter.lastAttemptFrom}T00:00:00`).getTime() : null;
    const lastAttemptTo = filter.lastAttemptTo ? new Date(`${filter.lastAttemptTo}T23:59:59.999`).getTime() : null;
    // 错题口径与题库页一致：用进度口径（rolling/round）内的原始作答重建
    // 「错后连对序列」，而不是终身聚合表（attemptStats 的 correctStreakAfterWrong
    // 是终身值，无法回答「这个窗口里它还算错题吗」）。只在需要时对候选集计算。
    const scopedWrongStats = filter.status === "wrong"
      ? buildScopedQuestionStats(questions.map((question) => question.id), progressScope, attemptRows, roundProgress, Date.now())
      : null;
    questions = questions.filter((question) => {
      const metric = attemptMetrics.get(question.id) ?? summarizeV7AttemptStats();
      const doneInScope = isQuestionDoneInScope(question.id, progressScope, statsRows, roundProgress, Date.now());
      if (filter.status === "unanswered" && doneInScope) return false;
      if (filter.status === "wrong") {
        const scoped = scopedWrongStats?.get(question.id);
        if (!statsNeedWrongReview(scoped ? scopedStatsToLegacyAttemptStats(scoped) : undefined, preferences.wrongRemovalStreak)) return false;
      }
      if (filter.status === "favorite" && !question.favorite) return false;
      if (filter.totalAttemptsMin !== null && metric.total < filter.totalAttemptsMin) return false;
      if (filter.totalAttemptsMax !== null && metric.total > filter.totalAttemptsMax) return false;
      if (filter.wrongAttemptsMin !== null && metric.wrong < filter.wrongAttemptsMin) return false;
      if (filter.wrongAttemptsMax !== null && metric.wrong > filter.wrongAttemptsMax) return false;
      if (filter.difficultyMin !== null && metric.difficulty < filter.difficultyMin) return false;
      if (filter.difficultyMax !== null && metric.difficulty > filter.difficultyMax) return false;
      if ((lastAttemptFrom !== null || lastAttemptTo !== null) && metric.latest === null) return false;
      if (lastAttemptFrom !== null && metric.latest !== null && metric.latest < lastAttemptFrom) return false;
      if (lastAttemptTo !== null && metric.latest !== null && metric.latest > lastAttemptTo) return false;
      return true;
    });
    let limitApplied = false;
    if (filter.order === "random") {
      if (filter.limit) {
        questions = preferences.randomTypeBalance === "balanced"
          ? balancedRandomSample(questions, filter.limit)
          : shuffle(questions).slice(0, filter.limit);
        limitApplied = true;
      } else questions = shuffle(questions);
    }
    questions = TYPE_ORDER.flatMap((type) => {
      const group = questions.filter((question) => question.type === type);
      if (filter.order === "random") return shuffle(group);
      if (filter.order === "difficulty") return group.sort((a, b) => {
        const left = attemptMetrics.get(a.id);
        const right = attemptMetrics.get(b.id);
        return (right?.reviewPriority ?? 50) - (left?.reviewPriority ?? 50)
          || (right?.personalDifficulty ?? 50) - (left?.personalDifficulty ?? 50)
          || a.id.localeCompare(b.id);
      });
      return group;
    });
    if (filter.limit && !limitApplied) questions = questions.slice(0, filter.limit);
    if (!questions.length) {
      setNotice("没有符合当前条件的题目，请调整筛选条件");
      return;
    }
    const now = new Date().toISOString();
    const run = await createPracticeRunV7({
      bankId: practiceBanks[0].id,
      bankIds: requestedBankIds,
      bankName: practiceBanks.length === 1 ? (practiceBanks[0].displayName || practiceBanks[0].name) : `${practiceBanks.length} 个题库组合`,
      mode: filter.mode,
      modeLabel: filter.modeLabel ?? (filter.mode === "random30" || filter.mode === "randomCustom" ? `随机 ${filter.limit ?? preferences.groupSize} 题` : modeLabels[filter.mode]),
      questionIds: questions.map((question) => question.id),
      questionTypes: Object.fromEntries(questions.map((question) => [question.id, question.type])),
      shuffleOptions: preferences.shuffleOptions,
      optionOrders: preferences.shuffleOptions ? Object.fromEntries(questions.map((question) => [question.id, randomOptionOrder(question)])) : {},
      startedAt: now,
      updatedAt: now,
      revision: 1,
      ...(filter.reviewRoundId ? { reviewRoundId: filter.reviewRoundId } : {}),
    });
    setPracticeSession(activePracticeFromRun(run, 0));
    setView("practice");
  }

  async function startSearchPractice({ questions, label, shuffleOptions }: SearchPracticeOptions, questionId?: string, avoidOptionOrders?: Record<string, number[]>) {
    const uniqueQuestions = [...new Map(questions.map((question) => [question.id, question])).values()];
    const orderedQuestions = TYPE_ORDER.flatMap((type) => uniqueQuestions.filter((question) => question.type === type));
    const practiceBanks = banks.filter((bank) => orderedQuestions.some((question) => question.bankId === bank.id));
    if (!orderedQuestions.length || !practiceBanks.length) return;
    const now = new Date().toISOString();
    const run = await createPracticeRunV7({
      bankId: practiceBanks[0].id,
      bankIds: practiceBanks.map((bank) => bank.id),
      bankName: practiceBanks.length === 1 ? (practiceBanks[0].displayName || practiceBanks[0].name) : `${practiceBanks.length} 个题库组合`,
      mode: "advanced",
      modeLabel: label,
      questionIds: orderedQuestions.map((question) => question.id),
      questionTypes: Object.fromEntries(orderedQuestions.map((question) => [question.id, question.type])),
      shuffleOptions,
      optionOrders: shuffleOptions ? Object.fromEntries(orderedQuestions.map((question) => [question.id, randomOptionOrder(question, avoidOptionOrders?.[question.id])])) : {},
      startedAt: now,
      updatedAt: now,
      revision: 1,
    });
    setPracticeSession(activePracticeFromRun(run, Math.max(0, orderedQuestions.findIndex((question) => question.id === questionId))));
    setView("practice");
  }

  function openSearch(questionId?: string, keyword?: string, contentScope: SearchContentScope = "all") {
    const kw = (keyword ?? query).trim();
    if (kw) {
      try {
        const previous = JSON.parse(localStorage.getItem("study-search-history") ?? "[]") as unknown;
        const history = Array.isArray(previous) ? previous.filter((item): item is string => typeof item === "string") : [];
        localStorage.setItem("study-search-history", JSON.stringify([kw, ...history.filter((item) => item !== kw)].slice(0, 10)));
      } catch { localStorage.setItem("study-search-history", JSON.stringify([kw])); }
    }
    setSearchQuestionId(questionId);
    setSearchContentScope(contentScope);
    setSearchRevision((revision) => revision + 1);
    setView("search");
  }

  function changeSession(mutator: (session: ActivePractice) => ActivePractice) {
    setPracticeSession((current) => {
      if (!current) return current;
      const changed = mutator(current);
      if (changed === current) return current;
      const next = { ...changed, updatedAt: new Date().toISOString(), revision: current.revision + 1 };
      // The current question is React-only view state. Persist answer changes,
      // but do not let browsing back and forth create newer run revisions that
      // could outrank submitted progress received from another device.
      if (changed.answers !== current.answers) void savePracticeProgress(next);
      return next;
    });
  }

  async function resumePractice(runId?: string, preferredIndex?: number) {
    const run = runId ? await dbV7.practiceRuns.get(runId) : latestPracticeRun;
    if (!run || run.status !== "in_progress" || !run.questionIds.length) {
      setNotice("没有可以继续的练习记录");
      return;
    }
    let session = activePracticeFromRun(run, preferredIndex);
    if (!session.questionTypes || Object.keys(session.questionTypes).length !== session.questionIds.length) {
      const questions = await dbV7.questions.bulkGet(session.questionIds);
      session = {
        ...session,
        questionTypes: Object.fromEntries(questions.filter(Boolean).map((question) => [question!.id, question!.type])),
        updatedAt: new Date().toISOString(),
        revision: session.revision + 1,
      };
      await savePracticeProgress(session);
    }
    setPracticeSession(session);
    selectBanks(session.bankIds?.length ? session.bankIds : [session.bankId]);
    setView("practice");
  }

  async function abandonHistoryRun(runId: string) {
    const run = await dbV7.practiceRuns.get(runId);
    if (!run || run.status !== "in_progress") return;
    await setPracticeRunStatus(runId, "abandoned", run.answers);
    if (practiceSession?.runId === runId) setPracticeSession(null);
    setNotice("已放弃这次练习，记录仍会保留");
  }

  async function removeHistoryRun(runId: string) {
    const removed = await deletePracticeRun(runId);
    if (!removed) return;
    if (practiceSession?.runId === runId) setPracticeSession(null);
    if (resultRunId === runId) setResultRunId(undefined);
    setNotice("练习记录已删除，并加入同步队列");
  }

  function movePractice(offset: number) {
    setPracticeTransitionDirection(offset < 0 ? -1 : 1);
    changeSession((session) => {
      const nextIndex = session.currentIndex + offset;
      if (nextIndex >= session.questionIds.length) {
        setNotice("已到最后一题，可以回顾或查看本次结果");
        return session;
      }
      if (nextIndex < 0) return session;
      return { ...session, currentIndex: nextIndex };
    });
  }

  async function finishPractice() {
    if (!practiceSession) return;
    const answered = Object.values(practiceSession.answers).filter((answer) => answer.submitted).length;
    if (answered < practiceSession.questionIds.length && preferences.requireAllAnswered) {
      const firstUnanswered = practiceSession.questionIds.findIndex((id) => !practiceSession.answers[id]?.submitted);
      if (firstUnanswered >= 0) jumpPractice(firstUnanswered);
      setNotice(`还有 ${practiceSession.questionIds.length - answered} 道题未作答，已定位到第一道未答题`);
      return;
    }
    if (answered < practiceSession.questionIds.length) {
      setFinishPrompt(practiceSession.questionIds.length - answered);
      return;
    }
    await completePractice();
  }

  async function completePractice() {
    if (!practiceSession) return;
    await setPracticeRunStatus(practiceSession.runId, "completed", practiceSession.answers);
    setResultRunId(practiceSession.runId);
    setFinishPrompt(undefined);
    setView("practiceResult");
  }

  function saveAnswerState(questionId: string, answerState: PracticeAnswerState) {
    const stamped = { ...answerState, updatedAt: new Date().toISOString(), deviceId: getV7DeviceId(), eventId: crypto.randomUUID() };
    changeSession((session) => ({
      ...session,
      answers: { ...session.answers, [questionId]: stamped },
      lastAnsweredIndex: stamped.submitted ? session.questionIds.indexOf(questionId) : session.lastAnsweredIndex,
    }));
  }

  function jumpPractice(index: number) {
    if (!practiceSession || index < 0 || index >= practiceSession.questionIds.length) return;
    setPracticeTransitionDirection(index < practiceSession.currentIndex ? -1 : 1);
    changeSession((session) => ({ ...session, currentIndex: index }));
  }

  const navItems = [
    { id: "home" as const, label: "今日", icon: Home },
    { id: "banks" as const, label: "题库", icon: Library },
    { id: "practiceSetup" as const, label: "练习", icon: ListFilter },
    { id: "relations" as const, label: "知识整理", icon: Link2 },
    { id: "preferences" as const, label: "配置", icon: Settings2 },
    { id: "settings" as const, label: "同步", icon: Cloud },
  ];

  const mobileNavItems = navItems.filter(({ id }) => id !== "settings").map((item) => item.id === "relations" ? { ...item, label: "整理" } : item);

  function openMainView(nextView: View) {
    if (nextView === "relations") setGroupQuestionIds([]);
    if (nextView === "practiceSetup") setPracticeHubTab("start");
    if (nextView === view) workspaceRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    else {
      if (SCROLL_RESTORABLE_VIEWS.includes(view) && workspaceRef.current) viewScrollPositions.current[view] = workspaceRef.current.scrollTop;
      setView(nextView);
    }
    setSidebarOpen(false);
  }

  return (
    <Tooltip.Provider delayDuration={250}>
    <main className={`app-shell font-${preferences.fontSize} transition-${preferences.questionTransition} transition-${practiceTransitionDirection < 0 ? "back" : "forward"}`}>
      <PullToRefresh />
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand"><span className="brand-mark">拾</span><span>拾卷</span></div>
        <nav>
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`${view === id ? "nav-active" : ""} ${id === "settings" ? "desktop-sync-nav" : ""}`} aria-current={view === id ? "page" : undefined} onClick={() => openMainView(id)}>
              <Icon size={19} strokeWidth={1.8} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="local-dot" />本地数据已保存
          <small>{stats.pending ? `${stats.pending} 条等待同步` : "没有待同步更改"}</small>
          <small className="sidebar-build"><code>{__APP_COMMIT_SHA__.slice(0, 7)}</code> · {formatBuildTimestampShort()}</small>
        </div>
      </aside>
      <button className={`sidebar-backdrop ${sidebarOpen ? "visible" : ""}`} aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />

      <section ref={workspaceRef} className={`workspace ${view === "search" ? "view-search" : ""}`}>
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={20} /></button>
          <QuickSearch banks={banks} activeBankIds={activeBankIds} onOpenSearch={(keyword, questionId, contentScope) => { setQuery(keyword); openSearch(questionId, keyword, contentScope); }} />
          <div className="quick-sync-split"><button className={`sync-pill quick-sync ${quickSyncing || quickRestoring ? "syncing" : ""} ${quickSyncHolding ? "holding" : ""}`} disabled={quickSyncing || quickRestoring} aria-label="单击立即同步，长按恢复本地记录" onPointerDown={beginQuickSyncPress} onPointerMove={moveQuickSyncPress} onPointerUp={endQuickSyncPress} onPointerCancel={cancelQuickSyncPress} onLostPointerCapture={cancelQuickSyncPress} onContextMenu={(event) => event.preventDefault()} onClick={(event) => { if (event.detail === 0) void quickSync(); }}><span className="quick-sync-icon"><svg className="quick-sync-progress" viewBox="0 0 32 32" aria-hidden="true"><circle className="track" cx="16" cy="16" r="14" /><circle className="value" cx="16" cy="16" r="14" /></svg>{quickSyncing || quickRestoring ? <LoaderCircle className="spin" size={18} /> : <RefreshCw size={18} />}</span><span className="quick-sync-label">{quickSyncHolding ? "恢复" : quickRestoring ? "恢复中" : quickSyncing ? "同步中" : "同步"}</span></button><button className="sync-queue-trigger" type="button" aria-label={`查看本次同步，共 ${stats.pending} 组待同步事件`} onClick={() => setSyncDrawerOpen(true)}>{stats.pending.toLocaleString("zh-CN")}<ChevronRight size={14} /></button></div>
        </header>

        {smoothQuickSyncProgress && <div className="top-sync-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={smoothQuickSyncProgress.percent}><span>{smoothQuickSyncProgress.label}<em>{smoothQuickSyncProgress.percent}%</em></span><i aria-hidden="true"><b style={{ width: `${smoothQuickSyncProgress.percent}%` }} /></i></div>}

        {notice && <div className={`toast ${classifyNoticeTone(notice)}`} role={classifyNoticeTone(notice) === "error" ? "alert" : "status"} aria-live={classifyNoticeTone(notice) === "error" ? "assertive" : "polite"} aria-atomic="true"><Sparkles size={16} aria-hidden="true" /><span>{notice}</span>{notice === "已放弃上次练习" && discardedRun && <button className="toast-action" onClick={() => void undoDiscardPractice()}>撤销</button>}<button aria-label="关闭提示" onClick={() => setNotice("")}><X size={15} /></button></div>}
        <input ref={fileRef} type="file" accept={QUESTION_BANK_FILE_ACCEPT} hidden onChange={(event) => onImport(event.target.files?.[0])} />

        <div className={`content ${view === "practice" ? "practice-content" : ""}`}><Suspense fallback={<div className="route-loading"><LoaderCircle className="spin" size={24} /><span>正在载入页面…</span></div>}>
          {view === "home" && <Dashboard groupSize={preferences.groupSize} dailyGoalCount={preferences.dailyGoalCount} dailyGoalAccuracy={preferences.dailyGoalAccuracy} scopeProgress={scopeProgress} scopeLabel={selectedScopeLabel} scopeStats={scopeStats} stats={stats} banks={banks} latestPracticeRun={latestPracticeRun} selectedBankIds={activeBankIds} onBankToggle={toggleBank} onImport={() => fileRef.current?.click()} onStart={() => activeBankIds.length && void startPractice(quickFilter(activeBankIds, "random30", preferences.groupSize, preferences.progressScope))} onResume={(runId) => void resumePractice(runId)} onDiscardResume={(runId) => void discardSavedPractice(runId)} onMoreModes={() => setView("practiceSetup")} />}
          {view === "banks" && <BankLibraryView banks={banks} progressScope={preferences.progressScope} progressScopeLabel={selectedScopeLabel} wrongRemovalStreak={preferences.wrongRemovalStreak} onImport={() => fileRef.current?.click()} onImportInto={importIntoBank} onOpenRun={(runId) => { setResultRunId(runId); setView("practiceResult"); }} onNotice={setNotice} />}
          {view === "practiceSetup" && <><div className="page-heading compact"><div><p className="eyebrow">自由安排练习</p><h1>练习中心</h1><p>开始新的练习，或回看每一次练习的题目和成绩。</p></div></div><div className="practice-hub-tabs"><button className={practiceHubTab === "start" ? "active" : ""} onClick={() => setPracticeHubTab("start")}><Play size={16} />开始练习</button><button className={practiceHubTab === "history" ? "active" : ""} onClick={() => setPracticeHubTab("history")}><ClipboardCheck size={16} />练习记录</button></div>{practiceHubTab === "start" ? <><LatestPracticeBanner onContinue={(runId) => void resumePractice(runId)} onAbandon={(runId) => void abandonHistoryRun(runId)} onViewAll={() => setPracticeHubTab("history")} /><PracticeSetupView hideHeading groupSize={preferences.groupSize} defaultOrder={preferences.defaultOrder} progressScope={preferences.progressScope} wrongRemovalStreak={preferences.wrongRemovalStreak} rounds={reviewRounds} banks={banks} currentBankIds={activeBankIds} onBankChange={selectBanks} onStart={(filter) => void startPractice(filter)} /></> : <PracticeHistory onOpen={(runId) => { setResultRunId(runId); setView("practiceResult"); }} onContinue={(runId) => void resumePractice(runId)} onAbandon={(runId) => void abandonHistoryRun(runId)} onDelete={(runId) => void removeHistoryRun(runId)} />}</>}
          {view === "relations" && <KnowledgeView initialQuestionIds={groupQuestionIds} onStartTag={(tag) => { const bankIds = banks.map((bank) => bank.id); const filter = { ...quickFilter(bankIds, "sequential", preferences.groupSize, preferences.progressScope), mode: "tag" as const, tags: [tag] }; void startPractice(filter); }} onStartQuestions={(questions, label) => void startSearchPractice({ questions, label, shuffleOptions: preferences.shuffleOptions })} onNotice={setNotice} />}
          {view === "preferences" && <PreferencesView preferences={preferences} rounds={reviewRounds} banks={banks} pendingSync={stats.pending} onNotice={setNotice} onChange={updatePreferences} onRestored={handleRestoreSuccess} />}
          {view === "settings" && <SyncView pending={stats.pending} onNotice={setNotice} onRestored={handleRestoreSuccess} />}
          {view === "search" && <SearchView key={`search-${searchRevision}`} query={query} onQueryChange={setQuery} banks={banks} currentBankIds={activeBankIds} initialContentScope={searchContentScope} focusQuestionId={searchQuestionId} onFocusHandled={() => setSearchQuestionId(undefined)} wrongRemovalStreak={preferences.wrongRemovalStreak} progressScope={preferences.progressScope} defaultShuffleOptions={preferences.shuffleOptions} onStart={(options) => startSearchPractice(options)} onGroup={(questionIds) => { setGroupQuestionIds(questionIds); setView("relations"); }} onNotice={setNotice} />}
          {view === "practiceResult" && resultRunId && <PracticeRunResult runId={resultRunId} onBack={() => { setPracticeHubTab("history"); setView("practiceSetup"); }} onContinue={(runId, index) => void resumePractice(runId, index)} onRepeat={(questions, label, previousOptionOrders) => void startSearchPractice({ questions, label, shuffleOptions: preferences.shuffleOptions }, undefined, previousOptionOrders)} onNotice={setNotice} onGroup={(questionIds) => { setGroupQuestionIds(questionIds); setView("relations"); }} progressScope={preferences.progressScope} scopeLabel={selectedScopeLabel} />}
          {view === "practice" && practiceSession && activeQuestion && (
            <Practice key={activeQuestion.id} runId={practiceSession.runId} question={activeQuestion} initialState={practiceSession.answers[activeQuestion.id]} optionOrder={practiceSession.optionOrders?.[activeQuestion.id]} questionIds={practiceSession.questionIds} questionTypes={practiceSession.questionTypes ?? {}} answers={practiceSession.answers} index={practiceSession.currentIndex} total={practiceSession.questionIds.length} modeLabel={practiceSession.modeLabel} preferences={preferences} onStateChange={(state) => saveAnswerState(activeQuestion.id, state)} onJump={jumpPractice} onFavorite={async () => { const updated = await toggleQuestionFavorite(activeQuestion.id); setNotice(updated.favorite ? "已收藏这道题" : "已取消收藏"); }} onExit={() => { setPracticeSession(null); setView("home"); }} onPrevious={() => movePractice(-1)} onNext={() => movePractice(1)} onFinish={() => void finishPractice()} />
          )}
        </Suspense></div>
      </section>
      <SyncEventDrawer open={syncDrawerOpen} onClose={() => setSyncDrawerOpen(false)} items={syncItems} syncing={quickSyncing} progress={smoothQuickSyncProgress ?? quickSyncProgress} hotWindow={drawerHotWindow} syncedAt={drawerSyncedAt} onSyncNow={() => quickSync()} onDelete={(id, options) => syncApplication.discardPendingChange(id, options)} />
      <ConfirmDialog open={Boolean(quickRestorePrompt)} eyebrow="恢复本地记录" title="确认恢复" tone="danger" busy={quickRestoring} progress={quickRestoring ? smoothQuickSyncProgress ?? quickSyncProgress : undefined} confirmLabel="确认恢复" onCancel={() => setQuickRestorePrompt(undefined)} onConfirm={() => void confirmQuickRestore()} description={quickRestorePrompt ? <><strong>恢复到本地 {new Date(quickRestorePrompt.cachedAt).toLocaleString("zh-CN")} 的记录</strong><span>共包含 {quickRestorePrompt.questionCount} 道题。当前设备在此时间之后产生的题库编辑、作答记录、解析、标签和练习进度将被放弃。</span></> : null} />
      <ConfirmDialog open={Boolean(quickRestoreSuccess)} eyebrow="数据恢复" title="恢复成功" tone="success" hideCancel confirmLabel="返回首页" onCancel={() => undefined} onConfirm={() => setQuickRestoreSuccess(undefined)} description={<><strong>本地数据已经恢复</strong><span>{quickRestoreSuccess} 已清空当前练习界面并返回首页。</span></>} />
      <ConfirmDialog open={finishPrompt !== undefined} eyebrow="结束本次练习" title="还有题目未作答" tone="danger" confirmLabel="仍然结束" onCancel={() => setFinishPrompt(undefined)} onConfirm={() => void completePractice()} description={<><strong>还有 {finishPrompt ?? 0} 道题未作答</strong><span>结束后会保存当前作答，并直接进入本次练习结果。</span></>} />
      <nav className={`mobile-tabbar ${view === "practice" ? "hidden" : ""}`} aria-label="手机主导航">
        {mobileNavItems.map(({ id, label, icon: Icon }) => (
          <button key={id} className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => openMainView(id)}>
            <Icon size={20} strokeWidth={view === id ? 2.2 : 1.8} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </main>
    </Tooltip.Provider>
  );
}
