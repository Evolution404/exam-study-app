import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useSmoothProgress } from "@/app/practice/use-smooth-progress";
import { classifyPressIntent, QUICK_RESTORE_HOLD_MS, shouldCancelQuickSyncMove } from "@/lib/practice/press-intent";
import { syncApplication, type SyncHotWindowState, type SyncProgress } from "@/lib/sync/sync-application";
import { syncRuntime } from "@/lib/sync/sync-runtime";
import type { GitHubSettings } from "@/types/types";
import type { PracticePreferences, View } from "./helpers";
import { formatQuickSyncNotice } from "./shell-controller-model";

interface QuickSyncControllerOptions {
  preferences: PracticePreferences;
  pending: number;
  setView: Dispatch<SetStateAction<View>>;
  setNotice: Dispatch<SetStateAction<string>>;
  refreshActivePracticeAfterSync: () => Promise<void>;
  resetExternalAfterRestore: () => void;
}

export function useQuickSyncController({
  preferences,
  pending,
  setView,
  setNotice,
  refreshActivePracticeAfterSync,
  resetExternalAfterRestore,
}: QuickSyncControllerOptions) {
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
  const quickSyncPress = useRef<{ timer: number; pointerId: number; startX: number; startY: number; startedAt: number; longPressed: boolean; cancelled: boolean } | null>(null);

  const resetQuickSyncPress = useCallback((cancelPendingRestore = true) => {
    const press = quickSyncPress.current;
    if (press) {
      window.clearTimeout(press.timer);
      if (cancelPendingRestore) press.cancelled = true;
    }
    quickSyncPress.current = null;
    setQuickSyncHolding(false);
  }, []);

  const syncItemsRaw = useLiveQuery(
    () => syncDrawerOpen ? syncApplication.listQueueItems(300) : Promise.resolve([]),
    [syncDrawerOpen],
  );
  const syncItems = useMemo(() => syncDrawerOpen ? (syncItemsRaw ?? []) : [], [syncItemsRaw, syncDrawerOpen]);

  function handleRestoreSuccess(message: string) {
    resetExternalAfterRestore();
    setQuickSyncing(false);
    setQuickRestoring(false);
    setQuickSyncHolding(false);
    setQuickSyncProgress(undefined);
    setQuickRestorePrompt(undefined);
    if (quickSyncPress.current) window.clearTimeout(quickSyncPress.current.timer);
    quickSyncPress.current = null;
    setQuickRestoreSuccess(message);
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
      if (!silent) setNotice(formatQuickSyncNotice(result));
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
      pending,
      threshold: preferences.autoSyncEventThreshold,
      blocked: quickRestoring,
      onError: () => undefined,
    });
  }, [pending, preferences.autoSyncEnabled, preferences.autoSyncEventThreshold, quickRestoring]);

  useEffect(() => {
    return syncRuntime.startPeriodicPull({
      enabled: preferences.periodicPullEnabled,
      seconds: preferences.periodicPullSeconds,
      blocked: () => quickRestoring,
      onError: (error) => setNotice(error instanceof Error ? `定期拉取失败：${error.message}` : "定期拉取失败"),
    });
  }, [preferences.periodicPullEnabled, preferences.periodicPullSeconds, quickRestoring, setNotice]);

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
    resetQuickSyncPress();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a progressive enhancement.
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
    if (!shouldCancelQuickSyncMove(dx, dy)) return;
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
    } else if (intent === "complete") {
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

  return {
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
  };
}
