import { useEffect, useState } from "react";
import { Cloud, CloudDownload, DatabaseBackup, GitBranch, LoaderCircle } from "lucide-react";
import { getGitHubLogin, getLastRemoteCache, restoreFromGitHub, restoreLastRemoteCache, syncWithGitHub } from "@/lib/github-sync";
import type { GitHubSettings } from "@/lib/types";

const DEFAULT_SETTINGS: GitHubSettings = { owner: "", repo: "exam-study-vault", branch: "main" };

function loadSettings() {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try { return JSON.parse(localStorage.getItem("github-settings") ?? "") as GitHubSettings; }
  catch { return DEFAULT_SETTINGS; }
}

export function SyncView({ pending, onNotice }: { pending: number; onNotice: (message: string) => void }) {
  const [settings, setSettings] = useState<GitHubSettings>(loadSettings);
  const [token, setToken] = useState(() => typeof window === "undefined" ? "" : sessionStorage.getItem("github-token") ?? "");
  const [syncing, setSyncing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoringCache, setRestoringCache] = useState(false);
  const [lastCache, setLastCache] = useState<Awaited<ReturnType<typeof getLastRemoteCache>>>(null);
  const ready = Boolean(settings.repo && token);

  useEffect(() => {
    let active = true;
    const cache = settings.owner && settings.repo ? getLastRemoteCache(settings) : Promise.resolve(null);
    void cache.then((value) => { if (active) setLastCache(value); });
    return () => { active = false; };
  }, [settings]);

  async function resolveSettings() {
    const resolved = settings.owner ? settings : { ...settings, owner: await getGitHubLogin(token) };
    setSettings(resolved);
    localStorage.setItem("github-settings", JSON.stringify(resolved));
    sessionStorage.setItem("github-token", token);
    return resolved;
  }

  async function sync() {
    if (!ready) return;
    try {
      setSyncing(true);
      const resolved = await resolveSettings();
      const result = await syncWithGitHub(resolved, token);
      setLastCache(await getLastRemoteCache(resolved));
      onNotice(`同步完成：上传 ${result.pushed} 条，接收 ${result.pulled} 条${result.compacted ? "，远程数据已压缩" : ""}${result.remaining ? `，待同步 ${result.remaining} 条` : ""}`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "同步失败");
    } finally { setSyncing(false); }
  }

  async function restoreFromCache() {
    if (!lastCache || restoringCache) return;
    if (!window.confirm(`恢复到本地 ${new Date(lastCache.cachedAt).toLocaleString("zh-CN")} 的记录？当前设备在此时间之后的修改将被放弃。`)) return;
    try {
      setRestoringCache(true);
      const result = await restoreLastRemoteCache(settings);
      localStorage.removeItem("study-current-banks");
      window.alert(`本地恢复完成：已恢复 ${result.counts.questions} 道题及对应学习记录。页面将重新载入。`);
      window.location.reload();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "本地缓存恢复失败");
      setRestoringCache(false);
    }
  }

  async function restoreFromRemote() {
    if (!ready || restoring) return;
    if (!window.confirm("这会永久丢弃当前浏览器中的题库、作答记录、解析、标签和未同步更改，然后仅用 GitHub 远程数据重建。确定继续吗？")) return;
    try {
      setRestoring(true);
      const result = await restoreFromGitHub(await resolveSettings(), token);
      localStorage.removeItem("study-current-banks");
      window.alert(`恢复完成：已通过 v${result.formatVersion} 远程数据重建本地，共应用 ${result.pulled} 条记录。页面将重新载入。`);
      window.location.reload();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "远程恢复失败");
      setRestoring(false);
    }
  }

  return <>
    <div className="page-heading compact"><div><p className="eyebrow">无需自建服务器</p><h1>GitHub 同步</h1><p>使用私有仓库保存资料库快照与增量记录。</p></div></div>
    <div className="settings-grid"><section className="settings-card"><div className="settings-title"><span><GitBranch /></span><div><h2>连接私有仓库</h2><p>令牌只保留在当前浏览器会话中。</p></div></div><label>仓库所有者<input value={settings.owner} onChange={(event) => setSettings({ ...settings, owner: event.target.value.trim() })} placeholder="github-username" /></label><label>仓库名称<input value={settings.repo} onChange={(event) => setSettings({ ...settings, repo: event.target.value.trim() })} placeholder="exam-study-vault" /></label><div className="field-row"><label>分支<input value={settings.branch} onChange={(event) => setSettings({ ...settings, branch: event.target.value.trim() || "main" })} /></label><label>细粒度令牌<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="github_pat_…" /></label></div><button className="primary full" disabled={!ready || syncing} onClick={sync}>{syncing ? <LoaderCircle className="spin" size={18} /> : <Cloud size={18} />}{syncing ? "正在合并…" : `立即同步${pending ? `（${pending}）` : ""}`}</button></section>
      <section className="guide-card"><span className="section-kicker">首次设置</span><h2>三步建立同步资料库</h2><ol><li><span>1</span><div><strong>新建私有仓库</strong><p>建议命名 exam-study-vault，并创建 README。</p></div></li><li><span>2</span><div><strong>创建细粒度令牌</strong><p>只授权该仓库的 Contents 读写权限。</p></div></li><li><span>3</span><div><strong>在每台设备连接</strong><p>首次拉取后，题库和学习记录会自动合并。</p></div></li></ol></section></div>
    <section className="restore-card local-restore-card"><div className="restore-icon"><DatabaseBackup /></div><div><span className="section-kicker">直接恢复</span><h2>恢复本地记录</h2><p>{lastCache ? `恢复到本地 ${new Date(lastCache.cachedAt).toLocaleString("zh-CN")} 的记录。` : "成功同步一次后，这里会保留最近一次可直接恢复的本地记录。"}</p></div><button className="danger-button" disabled={!lastCache || syncing || restoring || restoringCache} onClick={restoreFromCache}>{restoringCache ? <LoaderCircle className="spin" size={18} /> : <DatabaseBackup size={18} />}{restoringCache ? "正在恢复…" : "直接恢复"}</button></section>
    <section className="restore-card remote-restore-card"><div className="restore-icon"><CloudDownload /></div><div><span className="section-kicker">重新获取数据</span><h2>从 GitHub 恢复</h2><p>重新下载远程资料库并完整重建当前设备的数据，适合本地恢复记录不可用或需要获取远端最新状态时使用。</p></div><button className="secondary-action" disabled={!ready || syncing || restoring || restoringCache} onClick={restoreFromRemote}>{restoring ? <LoaderCircle className="spin" size={18} /> : <CloudDownload size={18} />}{restoring ? "正在下载并重建…" : "从 GitHub 恢复"}</button></section>
  </>;
}
