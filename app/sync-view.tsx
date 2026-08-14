import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Cloud, CloudDownload, DatabaseBackup, GitBranch, LoaderCircle, Trash2 } from "lucide-react";
import { getGitHubLogin, getLastRemoteCache, getSyncHotWindowState, restoreFullHistoryFromGitHub, restoreLastRemoteCache, syncWithGitHub } from "@/lib/github-sync";
import type { SyncHotWindowState, SyncProgress } from "@/lib/github-sync";
import { loadGitHubSettings, loadGitHubToken, saveGitHubSettings, saveGitHubToken } from "@/lib/github-credentials";
import { ConfirmDialog } from "@/app/confirm-dialog";
import { clearAllSiteData, clearSiteDataExceptConfig, reloadAsFreshSite } from "@/lib/site-data-reset";
import { dbV6 } from "@/lib/db-v6";
import { discardManagedChangeSetV7, reviseManagedChangeSetV7 } from "@/lib/change-set-v7-queue";
import { dependentChangeSetIdsV7 } from "@/lib/change-set-v7";
import { questionContentFingerprint } from "@/lib/question-content";
import { SyncEventManager, type SyncChangeSetItemV7, type SyncChangeSetTypedEditV7 } from "@/app/sync-event-manager";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 1024 * 10 ? 0 : 1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SyncView({ pending, onNotice, onRestored }: { pending: number; onNotice: (message: string) => void; onRestored: (message: string) => void }) {
  const [settings, setSettings] = useState(loadGitHubSettings);
  const [token, setToken] = useState(loadGitHubToken);
  const [syncing, setSyncing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoringCache, setRestoringCache] = useState(false);
  const [lastCache, setLastCache] = useState<Awaited<ReturnType<typeof getLastRemoteCache>>>(null);
  const [hotWindow, setHotWindow] = useState<SyncHotWindowState | null>(null);
  const [restorePrompt, setRestorePrompt] = useState<"cache" | "remote">();
  const [operationProgress, setOperationProgress] = useState<SyncProgress>();
  const [clearPrompt, setClearPrompt] = useState(false);
  const [clearing, setClearing] = useState(false);
  const ready = Boolean(settings.repo && token);
  const changeSets = useLiveQuery(() => dbV6.changeSets.orderBy("createdAt").reverse().limit(500).toArray(), []) ?? [];
  const manageableChangeSets = changeSets.filter((record) => record.state === "pending" || record.state === "blocked");
  const changeSetItems: SyncChangeSetItemV7[] = changeSets.map((record) => ({ changeSet: record, state: record.state, blockers: record.blockedReason ? [record.blockedReason] : undefined, dependentChangeSetIds: dependentChangeSetIdsV7(record, manageableChangeSets), editable: record.state === "pending" || record.state === "blocked", cancellable: record.state === "pending" || record.state === "blocked" }));

  useEffect(() => {
    let active = true;
    const cache = settings.owner && settings.repo ? getLastRemoteCache(settings) : Promise.resolve(null);
    void cache.then((value) => { if (active) setLastCache(value); });
    const hot = settings.owner && settings.repo ? getSyncHotWindowState(settings) : Promise.resolve(null);
    void hot.then((value) => { if (active) setHotWindow(value); });
    return () => { active = false; };
  }, [settings]);

  async function resolveSettings() {
    const resolved = settings.owner ? settings : { ...settings, owner: await getGitHubLogin(token) };
    setSettings(resolved);
    saveGitHubSettings(resolved);
    saveGitHubToken(token);
    return resolved;
  }

  function updateSettings(next: typeof settings) {
    setSettings(next);
    saveGitHubSettings(next);
  }

  function updateToken(next: string) {
    setToken(next);
    saveGitHubToken(next);
  }

  async function sync() {
    if (!ready) return;
    try {
      setSyncing(true);
      setOperationProgress({ phase: "prepare", label: "正在准备同步", percent: 0 });
      const resolved = await resolveSettings();
      const result = await syncWithGitHub(resolved, token, setOperationProgress);
      setLastCache(await getLastRemoteCache(resolved));
      setHotWindow(await getSyncHotWindowState(resolved));
      const received = result.receivedSnapshot
        ? `接收 ${result.receivedSnapshot.questions.toLocaleString("zh-CN")} 道题、${result.receivedSnapshot.totalAttempts.toLocaleString("zh-CN")} 条作答`
        : `接收 ${result.pulled} 组操作`;
      onNotice(`v${result.formatVersion} 同步完成：上传 ${result.pushed} 组操作，${received}${result.migrated ? "，云端已升级到最新格式" : ""}${result.compacted ? "，已生成新检查点" : ""}${result.coalesced ? "，已合并热窗口分段" : ""}${result.remaining ? `，本地待上传 ${result.remaining} 组操作` : ""}${result.deferred ? `，还有 ${result.deferred} 个远程增量页待下次同步` : ""}`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "同步失败");
    } finally { setSyncing(false); setOperationProgress(undefined); }
  }

  async function editChangeSet(id: string, edit: SyncChangeSetTypedEditV7) {
    const current = await dbV6.changeSets.get(id);
    if (!current || (current.state !== "pending" && current.state !== "blocked")) throw new Error("该变更已进入同步流程，不能继续修改。");
    const mutations = current.mutations.map((mutation, index) => {
      if (index !== edit.mutationIndex || mutation.kind !== edit.kind) return mutation;
      if (edit.kind === "note.upserted" && mutation.kind === "note.upserted") return { ...mutation, note: { ...mutation.note, content: edit.content, revision: mutation.note.revision + 1, updatedAt: new Date().toISOString() } };
      if (edit.kind === "bank.update" && mutation.kind === "bank.update") return { ...mutation, bank: { ...mutation.bank, name: edit.name.trim() || mutation.bank.name, displayName: edit.displayName.trim() || undefined, description: edit.description.trim() || undefined, updatedAt: new Date().toISOString() } };
      if (edit.kind === "question.upsert" && mutation.kind === "question.upsert") {
        let insertedText = false;
        const content: typeof mutation.question.content = [];
        for (const block of mutation.question.content) {
          if (block.type !== "text") content.push(block);
          else if (!insertedText) {
            content.push({ ...block, text: edit.stem });
            insertedText = true;
          }
        }
        if (!insertedText) content.unshift({ id: "stem-0", type: "text", text: edit.stem });
        const question = { ...mutation.question, answer: edit.answer, tags: edit.tags, content, updatedAt: new Date().toISOString() };
        return { ...mutation, question: { ...question, contentFingerprint: questionContentFingerprint(question) } };
      }
      return mutation;
    });
    await reviseManagedChangeSetV7(id, mutations);
  }

  async function restoreFromCache() {
    if (!lastCache || restoringCache) return;
    try {
      setRestoringCache(true);
      setOperationProgress({ phase: "prepare", label: "正在准备恢复", percent: 0 });
      const result = await restoreLastRemoteCache(settings, setOperationProgress);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
      setRestorePrompt(undefined);
      setRestoringCache(false);
      setOperationProgress(undefined);
      onRestored(`已从本机缓存恢复 ${result.counts.questions} 道题及对应学习记录。`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "本地缓存恢复失败");
      setRestoringCache(false);
      setOperationProgress(undefined);
    }
  }

  async function restoreFromRemote() {
    if (!ready || restoring) return;
    try {
      setRestoring(true);
      setOperationProgress({ phase: "prepare", label: "正在准备恢复", percent: 0 });
      const resolved = await resolveSettings();
      const result = await restoreFullHistoryFromGitHub(resolved, token, setOperationProgress);
      const successMessage = `已通过 v${result.formatVersion} 从远端恢复完整数据，另载入 ${result.archivedAttempts} 条归档作答和 ${result.archivedPracticeRuns} 次归档练习。${result.deferred ? `仍有 ${result.deferred} 个热增量页，请重新载入后继续同步。` : ""}`;
      setRestorePrompt(undefined);
      setRestoring(false);
      setOperationProgress(undefined);
      onRestored(successMessage);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "远程恢复失败");
      setRestoring(false);
      setOperationProgress(undefined);
    }
  }

  async function clearEverything() {
    if (clearing) return;
    try {
      setClearing(true);
      await clearAllSiteData();
      reloadAsFreshSite();
    } catch (error) {
      setClearing(false);
      onNotice(error instanceof Error ? error.message : "清除本机数据失败");
    }
  }

  async function clearEverythingButConfig() {
    if (clearing) return;
    try {
      setClearing(true);
      await clearSiteDataExceptConfig();
      reloadAsFreshSite();
    } catch (error) {
      setClearing(false);
      onNotice(error instanceof Error ? error.message : "清除本机数据失败");
    }
  }

  return <>
    <div className="page-heading compact"><div><p className="eyebrow">无需自建服务器</p><h1>GitHub 同步</h1><p>使用私有仓库保存资料库快照与增量记录。</p></div></div>
    <div className="settings-grid"><section className="settings-card sync-connection-card"><div className="settings-title"><span><GitBranch /></span><div><h2>连接私有仓库</h2><p>令牌仅保存在此设备浏览器，不会写入题库或上传到云端。</p></div></div><label>仓库所有者<input value={settings.owner} onChange={(event) => updateSettings({ ...settings, owner: event.target.value.trim() })} placeholder="github-username" /></label><label>仓库名称<input value={settings.repo} onChange={(event) => updateSettings({ ...settings, repo: event.target.value.trim() })} placeholder="exam-study-vault" /></label><div className="field-row"><label>分支<input value={settings.branch} onChange={(event) => updateSettings({ ...settings, branch: event.target.value })} placeholder="main" /></label><label>细粒度令牌<input type="password" value={token} onChange={(event) => updateToken(event.target.value)} placeholder="github_pat_…" /></label></div><label>同步中转地址（可选）<input value={settings.apiBaseUrl ?? ""} onChange={(event) => updateSettings({ ...settings, apiBaseUrl: event.target.value.trim() || undefined })} placeholder="https://sync.980923.xyz" /></label><div className={`sync-readiness ${ready ? "ready" : ""}`} role="status"><span aria-hidden="true" />{ready ? "连接信息已填写，可以开始同步" : "填写仓库所有者与令牌后即可同步"}</div><button className="primary full" disabled={!ready || syncing} onClick={sync}>{syncing ? <LoaderCircle className="spin" size={18} /> : <Cloud size={18} />}{syncing ? "正在合并…" : `立即同步${pending ? `（${pending}）` : ""}`}</button>{hotWindow && <dl className="sync-hot-window" role="status" aria-label="热窗口状态"><div><dt>检查点</dt><dd>{hotWindow.hasCheckpoint ? `第 ${hotWindow.generation} 代` : "未建立"}</dd></div><div><dt>分段</dt><dd>{hotWindow.segmentCount}</dd></div><div className="sync-hot-window-fill"><dt>热窗口</dt><dd><span>{formatBytes(hotWindow.hotBytes)} / {formatBytes(hotWindow.hotBytesMax)}</span><i aria-hidden="true"><b style={{ width: `${Math.min(100, Math.round((hotWindow.hotBytes / hotWindow.hotBytesMax) * 100))}%` }} /></i></dd></div></dl>}</section>
      <section className="guide-card"><span className="section-kicker">首次设置</span><h2>三步建立同步资料库</h2><ol><li><span>1</span><div><strong>新建私有仓库</strong><p>建议命名 exam-study-vault，并创建 README。</p></div></li><li><span>2</span><div><strong>创建细粒度令牌</strong><p>只授权该仓库的 Contents 读写权限。</p></div></li><li><span>3</span><div><strong>在每台设备连接</strong><p>首次拉取后，题库和学习记录会自动合并。</p></div></li></ol></section></div>
    <section className="restore-card data-restore-card"><div className="restore-icon"><DatabaseBackup /></div><div><span className="section-kicker">数据恢复</span><h2>选择恢复来源</h2><p>{lastCache ? `本地快照保存于 ${new Date(lastCache.cachedAt).toLocaleString("zh-CN")}；也可以从 GitHub 重新获取完整数据。` : "成功同步后会保存本地快照；也可以随时从 GitHub 重新获取完整数据。"}</p></div><div className="restore-card-actions"><button className="secondary-action" disabled={!lastCache || syncing || restoring || restoringCache} onClick={() => setRestorePrompt("cache")}>{restoringCache ? <LoaderCircle className="spin" size={18} /> : <DatabaseBackup size={18} />}{restoringCache ? "恢复中…" : "本地恢复"}</button><button className="secondary-action" disabled={!ready || syncing || restoring || restoringCache} onClick={() => setRestorePrompt("remote")}>{restoring ? <LoaderCircle className="spin" size={18} /> : <CloudDownload size={18} />}{restoring ? "恢复中…" : "远端恢复"}</button></div></section>
    <section className="restore-card clear-data-card"><div className="restore-icon"><Trash2 /></div><div><span className="section-kicker">恢复出厂状态</span><h2>清除本机所有数据</h2><p>删除题库、作答、练习、GitHub 令牌、配置、Cookie、Storage、IndexedDB、离线缓存和 Service Worker。远端私有仓库不会被删除。</p></div><button className="danger-button" disabled={syncing || restoring || restoringCache || clearing} onClick={() => setClearPrompt(true)}><Trash2 size={18} />清除数据</button></section>
    <section className="settings-card sync-events-page"><SyncEventManager items={changeSetItems} syncing={syncing} progress={operationProgress} showBatchSections onSyncNow={sync} onEdit={editChangeSet} onDelete={async (id, options) => { await discardManagedChangeSetV7(id, options); }} /></section>
    <ConfirmDialog open={syncing} eyebrow="GitHub 同步" title="正在同步云端数据" busy hideCancel progress={operationProgress} confirmLabel="同步中" onCancel={() => undefined} onConfirm={() => undefined} description={<><strong>正在安全合并本地与远程更改</strong><span>同步期间可以继续使用应用；新产生的记录会加入同步队列。</span></>} />
    <ConfirmDialog open={restorePrompt === "cache"} eyebrow="恢复本地记录" title="确认恢复" tone="danger" busy={restoringCache} progress={restoringCache ? operationProgress : undefined} confirmLabel="确认恢复" onCancel={() => setRestorePrompt(undefined)} onConfirm={() => void restoreFromCache()} description={<><strong>{lastCache ? `恢复到本地 ${new Date(lastCache.cachedAt).toLocaleString("zh-CN")} 的记录` : "恢复最近的本地记录"}</strong><span>当前设备在此时间之后产生的题库编辑、作答记录、解析、标签和练习进度将被放弃。</span></>} />
    <ConfirmDialog open={restorePrompt === "remote"} eyebrow="从 GitHub 恢复" title="确认重建本地数据" tone="danger" busy={restoring} progress={restoring ? operationProgress : undefined} confirmLabel="远端恢复" onCancel={() => setRestorePrompt(undefined)} onConfirm={() => void restoreFromRemote()} description={<><strong>当前浏览器的数据将被远端完整数据替换</strong><span>将重新获取题库、统计、作答和练习记录，并同时恢复可用的历史归档；耗时和流量取决于数据量。</span></>} />
    <ConfirmDialog open={clearPrompt} eyebrow="清除本机数据" title="恢复为首次加载状态？" tone="danger" busy={clearing} confirmLabel="清除并重新载入" secondaryLabel="清除并保留配置" onSecondary={() => void clearEverythingButConfig()} onCancel={() => setClearPrompt(false)} onConfirm={() => void clearEverything()} description={<><strong>此操作只清除当前网站在这台设备上的全部数据</strong><span>题库、作答、练习、配置和 GitHub 令牌都将删除，且无法从本机撤销；远端私有仓库保持不变。</span></>} />
  </>;
}
