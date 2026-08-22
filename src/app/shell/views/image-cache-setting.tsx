"use client";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Cloud } from "lucide-react";
import { getImageCacheSizeV7 } from "@/lib/db/db-v7";
import { syncApplication } from "@/lib/sync/sync-application";
import type { ImageCacheDownloadProgress } from "@/lib/sync/image-asset-cache";

export function ImageCacheSetting({ onNotice }: { onNotice: (message: string) => void }) {
  const cachedBytes = useLiveQuery(() => getImageCacheSizeV7(), []) ?? 0;
  const [busy, setBusy] = useState(false);
  const [assetCount, setAssetCount] = useState<number | undefined>();
  const [progress, setProgress] = useState<ImageCacheDownloadProgress>();

  async function refreshStats() {
    try {
      const stats = await syncApplication.getImageCacheStats();
      if (stats && typeof stats === "object" && "cached" in stats) {
        const count = Number((stats as { cached?: unknown }).cached);
        if (Number.isFinite(count)) setAssetCount(count);
      }
    } catch { /* image cache stats are best-effort */ }
  }

  async function cacheAll() {
    if (busy) return;
    if (!syncApplication.getConnection().ready) { onNotice("请先在同步页面配置 GitHub，才能缓存远程图片"); return; }
    setBusy(true);
    setProgress(undefined);
    try {
      await syncApplication.downloadAllImageAssets(setProgress);
      await refreshStats();
      onNotice("图片缓存已更新");
    } catch (error) { onNotice(error instanceof Error ? error.message : "图片缓存失败"); }
    finally { setBusy(false); setProgress(undefined); }
  }

  async function clearCache() {
    if (busy) return;
    setBusy(true);
    try {
      await syncApplication.clearImageCache();
      setAssetCount(0);
      onNotice("本机图片缓存已清理");
    } catch (error) { onNotice(error instanceof Error ? error.message : "清理图片缓存失败"); }
    finally { setBusy(false); }
  }

  return <section className="preference-card image-cache-setting"><div className="settings-title"><span><Cloud /></span><div><h2>图片缓存</h2><p>图片只保存在本机缓存，不会在题目中写入 URL。离线时仍可查看已缓存图片。</p></div></div>{progress && <div className="image-cache-progress" role="progressbar" aria-label="图片缓存进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><span>正在并发下载图片 {progress.completed}/{progress.total}</span><strong>{progress.percent}%</strong><i aria-hidden="true"><b style={{ width: `${progress.percent}%` }} /></i></div>}<div className="image-cache-actions"><span>已缓存 {assetCount === undefined ? "—" : assetCount.toLocaleString()} 个文件 · {(cachedBytes / 1024 / 1024).toFixed(1)} MB</span><div className="image-cache-buttons"><button type="button" className="primary" disabled={busy} onClick={() => void cacheAll()}>{busy ? "处理中…" : "缓存全部图片"}</button><button type="button" className="danger-button" disabled={busy} onClick={() => void clearCache()}>清空缓存</button></div></div></section>;
}
