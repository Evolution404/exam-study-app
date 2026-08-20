import fs from "node:fs";

const path = "src/app/shell/app-shell.tsx";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(from, to, label) {
  if (!source.includes(from)) throw new Error(`sync UI migration: missing ${label}`);
  source = source.replace(from, to);
}

replaceOnce(
`import type { SyncProgress, SyncHotWindowState } from "@/lib/sync/github-sync";\nimport { getGitHubLogin, getLastRemoteCache, getSyncHotWindowState, pullFromGitHub, restoreLastRemoteCache, syncWithGitHub } from "@/lib/sync/github-sync";\nimport { loadGitHubSettings, loadGitHubToken, saveGitHubSettings } from "@/lib/sync/github-credentials";`,
`import { syncApplication, type SyncProgress, type SyncHotWindowState } from "@/lib/sync/sync-application";\nimport { syncRuntime } from "@/lib/sync/sync-runtime";`,
"sync imports",
);

replaceOnce(
`import { SyncEventDrawer } from "@/app/sync/sync-event-drawer";\nimport type { SyncChangeSetItemV7 } from "@/app/sync/sync-event-manager";\nimport { dependentChangeSetIdsV7 } from "@/lib/sync/change-set-v7";\nimport { discardManagedChangeSetV7, ensureChangeSetQueueBaseV7 } from "@/lib/sync/change-set-v7-queue";`,
`import { SyncEventDrawer } from "@/app/sync/sync-event-drawer";`,
"queue imports",
);

replaceOnce(
`  const syncOperationRunning = useRef(false);\n  const automaticSyncRunning = useRef(false);\n  const periodicPullRunning = useRef(false);\n  const quickSyncAction = useRef<(options?: { silent?: boolean }) => Promise<void>>(async () => undefined);\n  const lastAutomaticSyncAt = useRef(0);\n`,
``,
"runtime refs",
);

replaceOnce(
`    void ensureChangeSetQueueBaseV7();`,
`    void syncApplication.ensureQueueBase();`,
"queue base initialization",
);

replaceOnce(
`  const pendingCountQuery = useLiveQuery(() => dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).count(), []);`,
`  const pendingCountQuery = useLiveQuery(() => syncApplication.pendingCount(), []);`,
"pending count",
);

replaceOnce(
`  const syncChangeSetsRaw = useLiveQuery(() => dbV7.changeSets.orderBy("createdAt").reverse().limit(300).toArray(), []);\n  const syncChangeSets = useMemo(() => syncChangeSetsRaw ?? [], [syncChangeSetsRaw]);\n  // Dependency resolution is only needed when the change-set list actually\n  // changes; memoising it keeps every answer submission (which re-renders the\n  // app) from re-running the O(n) scan over the event queue.  抽屉关闭时\n  // SyncEventDrawer 本就渲染 null，跳过整段 O(300×pending) 依赖解析——\n  // 这是自动同步期间不必要的重渲染主力。\n  const syncItems: SyncChangeSetItemV7[] = useMemo(() => {\n    if (!syncDrawerOpen) return [];\n    const manageableChangeSets = syncChangeSets.filter((record) => record.state === "pending" || record.state === "blocked");\n    return syncChangeSets.map((record) => ({\n      changeSet: record,\n      state: record.state,\n      blockers: record.blockedReason ? [record.blockedReason] : undefined,\n      dependentChangeSetIds: dependentChangeSetIdsV7(record, manageableChangeSets),\n      editable: record.state === "pending" || record.state === "blocked",\n      cancellable: record.state === "pending" || record.state === "blocked",\n    }));\n  }, [syncChangeSets, syncDrawerOpen]);`,
`  const syncItemsRaw = useLiveQuery(() => syncApplication.listQueueItems(300), []);\n  // 队列依赖解析已下沉到 sync-application；抽屉关闭时仍跳过列表渲染。\n  const syncItems = useMemo(() => syncDrawerOpen ? (syncItemsRaw ?? []) : [], [syncItemsRaw, syncDrawerOpen]);`,
"queue projection",
);

const quickSyncStart = source.indexOf("  async function quickSync({ silent = false }");
const drawerComment = source.indexOf("  // 同步抽屉打开时", quickSyncStart);
if (quickSyncStart < 0 || drawerComment < 0) throw new Error("sync UI migration: missing quickSync block");
source = source.slice(0, quickSyncStart) + `  async function quickSync({ silent = false }: { silent?: boolean } = {}) {\n    if (syncRuntime.isBusy() || quickRestoring) return;\n    const connection = syncApplication.getConnection();\n    if (!connection.ready) {\n      if (!silent) {\n        setNotice("请先在配置页面填写 GitHub 令牌");\n        setView(window.matchMedia("(max-width: 760px)").matches ? "preferences" : "settings");\n      }\n      return;\n    }\n    try {\n      if (!silent) {\n        setQuickSyncing(true);\n        setQuickSyncProgress({ phase: "prepare", label: "正在准备同步", percent: 0 });\n      }\n      const result = await syncRuntime.sync(silent ? undefined : setQuickSyncProgress);\n      if (!silent) {\n        const received = result.receivedSnapshot\n          ? \`接收 \${result.receivedSnapshot.questions.toLocaleString("zh-CN")} 道题、\${result.receivedSnapshot.totalAttempts.toLocaleString("zh-CN")} 条作答\`\n          : \`接收 \${result.pulled} 组操作\`;\n        setNotice(\`同步完成：上传 \${result.pushed} 组操作，\${received}\${result.compacted ? "，远程数据已压缩" : ""}\${result.remaining ? \`，待同步 \${result.remaining} 组操作\` : ""}\`);\n      }\n      if (result.pulled || result.receivedSnapshot) await refreshActivePracticeAfterSync();\n    } catch (error) {\n      if (!silent) setNotice(error instanceof Error ? error.message : "同步失败，请检查令牌和网络");\n    } finally {\n      if (!silent) {\n        setQuickSyncing(false);\n        setQuickSyncProgress(undefined);\n      }\n    }\n  }\n\n` + source.slice(drawerComment);

replaceOnce(
`    const settings = loadGitHubSettings();\n    let active = true;\n    const load = settings.repo\n      ? Promise.all([getLastRemoteCache(settings), getSyncHotWindowState(settings)]).then(([cache, hotWindow]) => ({ hotWindow, syncedAt: cache?.cachedAt ?? null }))\n      : Promise.resolve({ hotWindow: null, syncedAt: null });`,
`    const settings = syncApplication.getConnection().settings;\n    let active = true;\n    const load = settings.repo\n      ? Promise.all([syncApplication.getLastRemoteCache(settings), syncApplication.getHotWindow(settings)]).then(([cache, hotWindow]) => ({ hotWindow, syncedAt: cache?.cachedAt ?? null }))\n      : Promise.resolve({ hotWindow: null, syncedAt: null });`,
"drawer status load",
);

const autoStart = source.indexOf("  useEffect(() => {\n    if (!preferences.autoSyncEnabled");
const prepareRestoreStart = source.indexOf("  async function prepareQuickRestore()", autoStart);
if (autoStart < 0 || prepareRestoreStart < 0) throw new Error("sync UI migration: missing scheduling block");
source = source.slice(0, autoStart) + `  useEffect(() => {\n    return syncRuntime.scheduleAutomaticSync({\n      enabled: preferences.autoSyncEnabled,\n      pending: stats.pending,\n      threshold: preferences.autoSyncEventThreshold,\n      blocked: quickRestoring,\n      onError: () => undefined,\n    });\n  }, [preferences.autoSyncEnabled, preferences.autoSyncEventThreshold, quickRestoring, stats.pending]);\n\n  useEffect(() => {\n    return syncRuntime.startPeriodicPull({\n      enabled: preferences.periodicPullEnabled,\n      seconds: preferences.periodicPullSeconds,\n      blocked: () => quickRestoring,\n      onError: (error) => setNotice(error instanceof Error ? \`定期拉取失败：\${error.message}\` : "定期拉取失败"),\n    });\n  }, [preferences.periodicPullEnabled, preferences.periodicPullSeconds, quickRestoring]);\n\n` + source.slice(prepareRestoreStart);

replaceOnce(
`    let settings: GitHubSettings;\n    try {\n      settings = JSON.parse(localStorage.getItem("github-settings") ?? "") as GitHubSettings;\n    } catch {\n      setNotice("本机还没有远程缓存，请先成功同步一次");\n      return;\n    }`,
`    const settings: GitHubSettings = syncApplication.getConnection().settings;`,
"quick restore settings",
);

replaceOnce(
`      const cached = await getLastRemoteCache(settings);`,
`      const cached = await syncApplication.getLastRemoteCache(settings);`,
"quick restore cache lookup",
);

replaceOnce(
`      const result = await restoreLastRemoteCache(quickRestorePrompt.settings, setQuickSyncProgress);`,
`      const result = await syncApplication.restoreCache(quickRestorePrompt.settings, setQuickSyncProgress);`,
"quick restore apply",
);

replaceOnce(
`onDelete={async (id, options) => { await discardManagedChangeSetV7(id, options); }}`,
`onDelete={(id, options) => syncApplication.discardPendingChange(id, options)}`,
"drawer delete",
);

fs.writeFileSync(path, source);
console.log("sync UI boundary migration applied");
