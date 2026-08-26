"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { ClipboardCheck, LoaderCircle, Play, Sparkles, X } from "lucide-react";
import { rebuildAttemptStatsFromAttemptsV7 } from "@/lib/db/db-v7";
import { syncApplication } from "@/lib/sync/sync-application";
import { ConfirmDialog } from "@/app/ui/confirm-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useAppTheme, useAppViewport } from "@/app/hooks/use-app-environment";
import { classifyNoticeTone } from "@/lib/practice/notice-tone";
import { persistConfigValue } from "@/platform/persistent-config";
import { importQuestionBankFile, QUESTION_BANK_FILE_ACCEPT } from "@/lib/question/question-bank-file-import";
import { SyncEventDrawer } from "@/app/sync/sync-event-drawer";
import { BankLibraryView, KnowledgeView, LatestPracticeBanner, PracticeHistory, PracticeRunResult, PracticeSetupView, SearchView, SyncView, loadPreferences, quickFilter, toggleQuestionFavorite, type PracticePreferences } from "./helpers";
import { Dashboard, Practice, PreferencesView, PullToRefresh } from "./views";
import { MobileTabbar, ShellSidebar } from "./navigation";
import { ShellTopbar } from "./topbar";
import { useShellNavigationState } from "./use-shell-navigation-state";
import { useDashboardData } from "./use-dashboard-data";
import { usePracticeSessionController } from "./use-practice-session-controller";
import { useQuickSyncController } from "./use-quick-sync-controller";

export function AppShell() {
  const {
    view,
    setView,
    sidebarOpen,
    setSidebarOpen,
    query,
    setQuery,
    searchContentScope,
    searchQuestionId,
    setSearchQuestionId,
    searchRevision,
    groupQuestionIds,
    setGroupQuestionIds,
    practiceHubTab,
    setPracticeHubTab,
    resultRunId,
    setResultRunId,
    workspaceRef,
    openSearch,
    openMainView,
    resetAfterRestore: resetNavigationAfterRestore,
  } = useShellNavigationState();
  const [notice, setNotice] = useState("");
  const [preferences, setPreferences] = useState<PracticePreferences>(loadPreferences);
  const fileRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), notice === "已放弃上次练习" ? 6000 : 3000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const {
    banks,
    enabledBanks,
    activeBankIds,
    latestPracticeRun,
    stats,
    reviewRounds,
    selectedScopeLabel,
    scopeProgress,
    scopeStats,
    selectBanks,
    toggleBank,
    resetSelectedBanks,
  } = useDashboardData(view, preferences);
  const {
    practiceSession,
    practiceTransitionDirection,
    discardedRun,
    finishPrompt,
    setFinishPrompt,
    activeQuestion,
    discardSavedPractice,
    undoDiscardPractice,
    refreshActivePracticeAfterSync,
    startPractice,
    startSearchPractice,
    resumePractice,
    abandonHistoryRun,
    removeHistoryRun,
    movePractice,
    finishPractice,
    completePractice,
    saveAnswerState,
    jumpPractice,
    exitPractice,
    resetAfterRestore: resetPracticeAfterRestore,
  } = usePracticeSessionController({
    view,
    setView,
    enabledBanks,
    preferences,
    latestPracticeRun,
    selectBanks,
    resultRunId,
    setResultRunId,
    setNotice,
  });
  function resetExternalAfterRestore() {
    resetNavigationAfterRestore();
    resetSelectedBanks();
    resetPracticeAfterRestore();
  }
  const {
    quickSyncing,
    quickRestoring,
    quickSyncProgress,
    smoothQuickSyncProgress,
    quickSyncHolding,
    syncDrawerOpen,
    setSyncDrawerOpen,
    drawerHotWindow,
    drawerSyncedAt,
    quickRestorePrompt,
    setQuickRestorePrompt,
    quickRestoreSuccess,
    setQuickRestoreSuccess,
    syncItems,
    quickSync,
    confirmQuickRestore,
    beginQuickSyncPress,
    moveQuickSyncPress,
    endQuickSyncPress,
    cancelQuickSyncPress,
    handleRestoreSuccess,
  } = useQuickSyncController({
    preferences,
    pending: stats.pending,
    setView,
    setNotice,
    refreshActivePracticeAfterSync,
    resetExternalAfterRestore,
  });

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

  async function updatePreferences(value: PracticePreferences): Promise<void> {
    setPreferences(value);
    try {
      await persistConfigValue("study-v7-preferences", JSON.stringify(value));
    } catch (error) {
      setNotice(error instanceof Error ? `配置保存失败：${error.message}` : "配置保存失败");
    }
  }

  return (
    <Tooltip.Provider delayDuration={250}>
    <main className={`app-shell font-${preferences.fontSize} transition-${preferences.questionTransition} transition-${practiceTransitionDirection < 0 ? "back" : "forward"}`}>
      <PullToRefresh />
      <ShellSidebar view={view} open={sidebarOpen} pending={stats.pending} onOpenView={openMainView} onClose={() => setSidebarOpen(false)} />

      <section ref={workspaceRef} className={`workspace ${view === "search" ? "view-search" : ""}`}>
        <ShellTopbar
          banks={enabledBanks}
          activeBankIds={activeBankIds}
          syncing={quickSyncing}
          restoring={quickRestoring}
          holding={quickSyncHolding}
          pending={stats.pending}
          progress={smoothQuickSyncProgress}
          onToggleMenu={() => setSidebarOpen(!sidebarOpen)}
          onOpenSearch={(keyword, questionId, contentScope) => { setQuery(keyword); openSearch(questionId, keyword, contentScope); }}
          onSync={() => void quickSync()}
          onOpenQueue={() => setSyncDrawerOpen(true)}
          onPointerDown={beginQuickSyncPress}
          onPointerMove={moveQuickSyncPress}
          onPointerUp={endQuickSyncPress}
          onPointerCancel={cancelQuickSyncPress}
          onLostPointerCapture={cancelQuickSyncPress}
        />

        {notice && <div className={`toast ${classifyNoticeTone(notice)}`} role={classifyNoticeTone(notice) === "error" ? "alert" : "status"} aria-live={classifyNoticeTone(notice) === "error" ? "assertive" : "polite"} aria-atomic="true"><Sparkles size={16} aria-hidden="true" /><span>{notice}</span>{notice === "已放弃上次练习" && discardedRun && <button className="toast-action" onClick={() => void undoDiscardPractice()}>撤销</button>}<button aria-label="关闭提示" onClick={() => setNotice("")}><X size={15} /></button></div>}
        <input ref={fileRef} type="file" accept={QUESTION_BANK_FILE_ACCEPT} hidden onChange={(event) => onImport(event.target.files?.[0])} />

        <div className={`content ${view === "practice" ? "practice-content" : ""}`}><Suspense fallback={<div className="route-loading"><LoaderCircle className="spin" size={24} /><span>正在载入页面…</span></div>}>
          {view === "home" && <Dashboard groupSize={preferences.groupSize} dailyGoalCount={preferences.dailyGoalCount} dailyGoalAccuracy={preferences.dailyGoalAccuracy} scopeProgress={scopeProgress} scopeLabel={selectedScopeLabel} scopeStats={scopeStats} stats={stats} banks={enabledBanks} latestPracticeRun={latestPracticeRun} selectedBankIds={activeBankIds} onBankToggle={toggleBank} onImport={() => fileRef.current?.click()} onStart={() => activeBankIds.length && void startPractice(quickFilter(activeBankIds, "random30", preferences.groupSize, preferences.progressScope))} onResume={(runId) => void resumePractice(runId)} onDiscardResume={(runId) => void discardSavedPractice(runId)} onMoreModes={() => setView("practiceSetup")} />}
          {view === "banks" && <BankLibraryView banks={banks} progressScope={preferences.progressScope} progressScopeLabel={selectedScopeLabel} wrongRemovalStreak={preferences.wrongRemovalStreak} onImport={() => fileRef.current?.click()} onImportInto={importIntoBank} onOpenRun={(runId) => { setResultRunId(runId); setView("practiceResult"); }} onNotice={setNotice} />}
          {view === "practiceSetup" && <><div className="page-heading compact"><div><p className="eyebrow">自由安排练习</p><h1>练习中心</h1><p>开始新的练习，或回看每一次练习的题目和成绩。</p></div></div><div className="practice-hub-tabs"><button className={practiceHubTab === "start" ? "active" : ""} onClick={() => setPracticeHubTab("start")}><Play size={16} />开始练习</button><button className={practiceHubTab === "history" ? "active" : ""} onClick={() => setPracticeHubTab("history")}><ClipboardCheck size={16} />练习记录</button></div>{practiceHubTab === "start" ? <><LatestPracticeBanner onContinue={(runId) => void resumePractice(runId)} onAbandon={(runId) => void abandonHistoryRun(runId)} onViewAll={() => setPracticeHubTab("history")} /><PracticeSetupView hideHeading groupSize={preferences.groupSize} defaultOrder={preferences.defaultOrder} progressScope={preferences.progressScope} wrongRemovalStreak={preferences.wrongRemovalStreak} rounds={reviewRounds} banks={enabledBanks} currentBankIds={activeBankIds} onBankChange={selectBanks} onStart={(filter) => void startPractice(filter)} /></> : <PracticeHistory onOpen={(runId) => { setResultRunId(runId); setView("practiceResult"); }} onContinue={(runId) => void resumePractice(runId)} onAbandon={(runId) => void abandonHistoryRun(runId)} onDelete={(runId) => void removeHistoryRun(runId)} />}</>}
          {view === "relations" && <KnowledgeView initialQuestionIds={groupQuestionIds} onStartTag={(tag) => { const bankIds = enabledBanks.map((bank) => bank.id); const filter = { ...quickFilter(bankIds, "sequential", preferences.groupSize, preferences.progressScope), mode: "tag" as const, tags: [tag] }; void startPractice(filter); }} onStartQuestions={(questions, label) => void startSearchPractice({ questions, label, shuffleOptions: preferences.shuffleOptions })} onNotice={setNotice} />}
          {view === "preferences" && <PreferencesView preferences={preferences} rounds={reviewRounds} banks={banks} pendingSync={stats.pending} onNotice={setNotice} onChange={updatePreferences} onRestored={handleRestoreSuccess} />}
          {view === "settings" && <SyncView pending={stats.pending} onNotice={setNotice} onRestored={handleRestoreSuccess} />}
          {view === "search" && <SearchView key={`search-${searchRevision}`} query={query} onQueryChange={setQuery} banks={enabledBanks} currentBankIds={activeBankIds} initialContentScope={searchContentScope} focusQuestionId={searchQuestionId} onFocusHandled={() => setSearchQuestionId(undefined)} wrongRemovalStreak={preferences.wrongRemovalStreak} progressScope={preferences.progressScope} defaultShuffleOptions={preferences.shuffleOptions} onStart={(options) => startSearchPractice(options)} onGroup={(questionIds) => { setGroupQuestionIds(questionIds); setView("relations"); }} onNotice={setNotice} />}
          {view === "practiceResult" && resultRunId && <PracticeRunResult runId={resultRunId} onBack={() => { setPracticeHubTab("history"); setView("practiceSetup"); }} onContinue={(runId, index) => void resumePractice(runId, index)} onRepeat={(questions, label, previousOptionOrders) => void startSearchPractice({ questions, label, shuffleOptions: preferences.shuffleOptions }, undefined, previousOptionOrders)} onNotice={setNotice} onGroup={(questionIds) => { setGroupQuestionIds(questionIds); setView("relations"); }} progressScope={preferences.progressScope} scopeLabel={selectedScopeLabel} />}
          {view === "practice" && practiceSession && activeQuestion && (
            <Practice key={activeQuestion.id} runId={practiceSession.runId} question={activeQuestion} initialState={practiceSession.answers[activeQuestion.id]} optionOrder={practiceSession.optionOrders?.[activeQuestion.id]} questionIds={practiceSession.questionIds} questionTypes={practiceSession.questionTypes ?? {}} answers={practiceSession.answers} index={practiceSession.currentIndex} total={practiceSession.questionIds.length} modeLabel={practiceSession.modeLabel} preferences={preferences} onStateChange={(state) => saveAnswerState(activeQuestion.id, state)} onJump={jumpPractice} onFavorite={async () => { const updated = await toggleQuestionFavorite(activeQuestion.id); setNotice(updated.favorite ? "已收藏这道题" : "已取消收藏"); }} onExit={exitPractice} onPrevious={() => movePractice(-1)} onNext={() => movePractice(1)} onFinish={() => void finishPractice()} />
          )}
        </Suspense></div>
      </section>
      <SyncEventDrawer open={syncDrawerOpen} onClose={() => setSyncDrawerOpen(false)} items={syncItems} syncing={quickSyncing} progress={smoothQuickSyncProgress ?? quickSyncProgress} hotWindow={drawerHotWindow} syncedAt={drawerSyncedAt} onSyncNow={() => quickSync()} onDelete={(id, options) => syncApplication.discardPendingChange(id, options)} />
      <ConfirmDialog open={Boolean(quickRestorePrompt)} eyebrow="恢复本地记录" title="确认恢复" tone="danger" busy={quickRestoring} progress={quickRestoring ? smoothQuickSyncProgress ?? quickSyncProgress : undefined} confirmLabel="确认恢复" onCancel={() => setQuickRestorePrompt(undefined)} onConfirm={() => void confirmQuickRestore()} description={quickRestorePrompt ? <><strong>恢复到本地 {new Date(quickRestorePrompt.cachedAt).toLocaleString("zh-CN")} 的记录</strong><span>共包含 {quickRestorePrompt.questionCount} 道题。当前设备在此时间之后产生的题库编辑、作答记录、解析、标签和练习进度将被放弃。</span></> : null} />
      <ConfirmDialog open={Boolean(quickRestoreSuccess)} eyebrow="数据恢复" title="恢复成功" tone="success" hideCancel confirmLabel="返回首页" onCancel={() => undefined} onConfirm={() => setQuickRestoreSuccess(undefined)} description={<><strong>本地数据已经恢复</strong><span>{quickRestoreSuccess} 已清空当前练习界面并返回首页。</span></>} />
      <ConfirmDialog open={finishPrompt !== undefined} eyebrow="结束本次练习" title="还有题目未作答" tone="danger" confirmLabel="仍然结束" onCancel={() => setFinishPrompt(undefined)} onConfirm={() => void completePractice()} description={<><strong>还有 {finishPrompt ?? 0} 道题未作答</strong><span>结束后会保存当前作答，并直接进入本次练习结果。</span></>} />
      <MobileTabbar view={view} onOpenView={openMainView} />
    </main>
    </Tooltip.Provider>
  );
}
